/**
 * Copyright (c) 2018-present, heineiuo.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { assert } from "./DBHelper";
import Version from "./Version";
import { getCurrentFilename, getManifestFilename } from "./Filename";
import Slice from "./Slice";
import {
  getExpandedCompactionByteSizeLimit,
  getMaxBytesForLevel,
} from "./VersionFormat";
import Status from "./Status";
import { FileMetaData } from "./VersionFormat";
import VersionBuilder from "./VersionBuilder";
import VersionEditRecord from "./VersionEditRecord";
import LogReader from "./LogReader";
import VersionEdit from "./VersionEdit";
import { Config, InternalKeyComparator, InternalKey, Entry } from "./Format";
import LogWriter from "./LogWriter";
import Compaction from "./Compaction";
import { Options, ReadOptions } from "./Options";
import { TableCache } from "./SSTableCache";
import Merger from "./Merger";
import { decodeFixed64 } from "./Coding";

interface RecoverResult {
  saveManifest?: boolean;
}

export default class VersionSet {
  // Per-level key at which the next compaction at that level should start.
  // Either an empty string, or a valid InternalKey.
  compactPointers: Slice[];
  _current!: Version;
  _dummyVersions: Version;
  hasLogNumber?: boolean;
  hasNextFileNumber?: boolean;
  hasPrevLogNumber?: boolean;

  logNumber = 0;

  // Return the log file number for the log file that is currently
  // being compacted, or zero if there is no such log file.
  // if prevLogNumber is 0, then no log file is being compacted
  prevLogNumber = 0;

  private _lastSequence = 0n;
  hasLastSequence?: boolean;
  manifestFileNumber = 0;
  nextFileNumber = 2;

  private _dbpath: string;
  _options: Options;
  internalKeyComparator: InternalKeyComparator;
  public tableCache: TableCache;

  manifestWriter?: LogWriter;

  constructor(
    dbpath: string,
    options: Options,
    tableCache: TableCache,
    internalKeyComparator: InternalKeyComparator,
  ) {
    this._dbpath = dbpath;
    this._options = options;
    this.tableCache = tableCache;
    this.internalKeyComparator = internalKeyComparator;
    this._dummyVersions = new Version(this);
    this.appendVersion(new Version(this));
    this.compactPointers = [];
  }

  get lastSequence(): bigint {
    return this._lastSequence;
  }

  set lastSequence(value: bigint) {
    this._lastSequence = value;
  }

  get current(): Version {
    return this._current;
  }

  public getLevelSummary(): string {
    let summary = "files [ ";
    for (let i = 0; i < this._current.files.length; i++) {
      summary += `${this._current.files[i].length} `;
    }
    summary += "]";
    return summary;
  }

  public compactRange(
    level: number,
    begin: InternalKey,
    end: InternalKey,
  ): Compaction | void {
    let inputs = this._current.getOverlappingInputs(level, begin, end);
    if (inputs.length === 0) return;

    // Avoid compacting too much in one shot in case the range is large.
    // But we cannot do this for level-0 since level-0 files can overlap
    // and we must not pick one file and drop another older file if the
    // two files overlap.
    if (level > 0) {
      const limit = this.maxFileSizeForLevel(this._options, level);
      let total = 0;
      for (let i = 0; i < inputs.length; i++) {
        total += inputs[i].fileSize;
        if (total >= limit) {
          inputs = inputs.slice(0, i + 1);
          break;
        }
      }
    }

    const compaction = new Compaction(this._options, level);
    compaction.inputVersion = this._current;
    compaction.inputVersion.ref();
    compaction.inputs[0] = inputs;
    this.setupOtherInputs(compaction);
    return compaction;
  }

  private maxFileSizeForLevel(options: Options, level: number): number {
    return options.maxFileSize;
  }

  public getNextFileNumber(): number {
    return this.nextFileNumber++;
  }

  public getNumLevelFiles(level: number): number {
    assert(level >= 0);
    assert(level <= Config.kNumLevels);
    return this._current.files[level].length;
  }

  public recover = async (): Promise<RecoverResult> => {
    const result: RecoverResult = {};
    // read current， check if end of content is '\n'
    const current = await this._options.env.readFile(
      getCurrentFilename(this._dbpath),
      "utf8",
    );
    if (!current || current[current.length - 1] !== "\n") {
      throw new Error("Invalid format of CURRENT file.");
    }

    let hasLogNumber = false;
    let hasNextFileNumber = false;
    let hasPrevLogNumber = false;
    let hasLastSequence = false;
    let logNumber = 0;
    let nextFileNumber = 0;
    let prevLogNumber = 0;
    let lastSequence = 0n;

    const builder = new VersionBuilder(this, this._current);
    const currentValue = current.substr(0, current.length - 1);
    const manifestNumber = Number(currentValue.substr("MANIFEST-".length));

    // Use current to read description file (manifest)
    const reader = new LogReader(
      await this._options.env.open(
        getManifestFilename(this._dbpath, manifestNumber),
        "r",
      ),
      // VersionEditRecord
    );
    // read record，apply to versionSet(apply method)
    // Update log number and prev log number（can be ignore because prev log number has
    // been deprecated in fact ）
    // Update next file
    // Update last sequence
    // Use version builder to create a new version
    for await (const editSlice of reader.iterator()) {
      const edit = VersionEditRecord.decode(editSlice);
      builder.apply(edit);

      // Update manifest_file_number_， next_file_number_， last_sequence_， log_number_， prev_log_number_
      if (edit.hasLogNumber) {
        logNumber = edit.logNumber;
        hasLogNumber = true;
      }

      if (edit.hasPrevLogNumber) {
        prevLogNumber = edit.prevLogNumber;
        hasPrevLogNumber = true;
      }

      if (edit.hasNextFileNumber) {
        nextFileNumber = edit.nextFileNumber;
        hasNextFileNumber = true;
      }

      if (edit.hasLastSequence) {
        lastSequence = edit.lastSequence;
        hasLastSequence = true;
      }
    }

    if (!hasNextFileNumber) {
      throw new Error("no meta-nextfile entry in descriptor");
    } else if (!hasLogNumber) {
      throw new Error("no meta-lognumber entry in descriptor");
    } else if (!hasLastSequence) {
      throw new Error("no last-sequence-number entry in descriptor");
    }

    if (!hasPrevLogNumber) {
      prevLogNumber = 0;
    }

    this.markFileNumberUsed(prevLogNumber);
    this.markFileNumberUsed(logNumber);

    // put apply's result to version(use finalize method)
    const version = new Version(this);
    builder.saveTo(version);
    this.finalize(version);

    // put version to version set(append version)
    this.appendVersion(version);
    this.manifestFileNumber = nextFileNumber;
    this.nextFileNumber = nextFileNumber + 1;
    this.lastSequence = lastSequence;
    this.logNumber = logNumber;
    this.prevLogNumber = prevLogNumber;

    // check if we can reuse manifest of need to create a new one
    // See if we can reuse the existing MANIFEST file.
    if (this.reuseManifest()) {
      // No need to save new manifest
    } else {
      result.saveManifest = true;
    }

    await reader.close();
    return result;
  };

  public markFileNumberUsed(num: number): void {
    if (this.nextFileNumber <= num) {
      this.nextFileNumber = num + 1;
    }
  }

  // Precomputed best level for next compaction
  private finalize(ver: Version): void {
    // traverse levels(0-6),
    // calculate score，0 level use files number / 8（kLevel0MaxFileSize)
    // other level use file bytes / maxFileBytes * 10^level
    // if score > best_score（best_score initial value - 1）, Update best_score and best_level
    // when traverse end,  Update version's best_score and best_level
    let bestLevel = -1;
    let bestScore = -1;
    for (let level = 0; level < Config.kNumLevels; level++) {
      let score = 0;
      if (level === 0) {
        score = ver.files[level].length / Config.kL0CompactionTrigger;
      } else {
        const levelBytes = this.getTotalBytes(ver.files[level]);
        if (this._options.debug)
          this._options.log(`DEBUG level=${level} levelBytes=${levelBytes}`);
        // score >= 1 means size is bigger then limit
        score = levelBytes / getMaxBytesForLevel(level);
      }

      if (score > bestScore) {
        bestScore = score;
        bestLevel = level;
      }
    }

    ver.compactionLevel = bestLevel;
    ver.compactionScore = bestScore;
  }

  private getTotalBytes(files: FileMetaData[]): number {
    let sum = 0;
    for (const f of files) {
      sum += f.fileSize;
    }
    return sum;
  }

  // append to manifest
  public async logAndApply(edit: VersionEdit): Promise<Status> {
    if (edit.hasLogNumber) {
      assert(edit.logNumber >= this.logNumber);
      assert(edit.logNumber < this.nextFileNumber);
    } else {
      edit.logNumber = this.logNumber;
    }

    if (!edit.hasPrevLogNumber) {
      edit.prevLogNumber = this.prevLogNumber;
    }

    edit.nextFileNumber = this.nextFileNumber;
    edit.lastSequence = this.lastSequence;

    const ver = new Version(this);
    const builder = new VersionBuilder(this, this._current);
    builder.apply(edit);
    builder.saveTo(ver);
    this.finalize(ver);

    // Initialize new descriptor log file if necessary by creating
    // a temporary file that contains a snapshot of the current version.
    let manifestFilename = "";
    let status = new Status();
    if (!this.manifestWriter) {
      // No reason to unlock *mu here since we only hit this path in the
      // first call to LogAndApply (when opening the database).
      manifestFilename = getManifestFilename(
        this._dbpath,
        this.manifestFileNumber,
      );
      edit.nextFileNumber = this.nextFileNumber;
      this.manifestWriter = new LogWriter(
        await this._options.env.open(manifestFilename, "a"),
      );
      if (this._options.debug)
        this._options.log("DEBUG writeSnapshot starting...");

      status = this.writeSnapshot(this.manifestWriter);
    }

    if (await status.ok()) {
      const record = VersionEditRecord.add(edit);
      status = new Status(this.manifestWriter.addRecord(record));
    } else {
      if (this._options.debug) this._options.log("DEBUG writeSnapshot fail");
    }

    // If we just created a new descriptor file, install it by writing a
    // new CURRENT file that points to it.
    if ((await status.ok()) && manifestFilename.length > 0) {
      status = new Status(
        this.writeCurrentFile(this._dbpath, this.manifestFileNumber),
      );
    }

    // Install the new version
    if (await status.ok()) {
      if (!!manifestFilename) {
        await this.manifestWriter.close();
        delete this.manifestWriter;
      }

      this._options.log("DEBUG LogAndApply success, Install the new version");

      this.appendVersion(ver);
      this.logNumber = edit.logNumber;
      this.prevLogNumber = edit.prevLogNumber;
    } else {
      this._options.log("DEBUG LogAndApply fail, Delete ver");
      // delete ver
      if (!!manifestFilename) {
        await this.manifestWriter.close();
        delete this.manifestWriter;
        await this._options.env.unlink(manifestFilename);
      }
    }

    return status;
  }

  public needsCompaction(): boolean {
    return this._current.compactionScore >= 1 || !!this._current.fileToCompact;
  }

  /**
   * update this._current
   */
  private appendVersion(ver: Version): void {
    assert(ver.refs === 0);
    assert(ver !== this._current);
    if (this._current) {
      this._current.unref();
    }
    this._current = ver;
    ver.ref();

    // Append to linked list
    ver.prev = this._dummyVersions.prev;
    ver.next = this._dummyVersions;
    ver.prev.next = ver;
    ver.next.prev = ver;
  }

  // TODO
  private reuseManifest(): boolean {
    return false;
  }

  /**
   * dump current to manifest
   */
  private writeSnapshot(writer: LogWriter): Status {
    const edit = new VersionEdit();

    // Save metadata
    edit.comparator = this.internalKeyComparator.userComparator.getName();

    // Save compaction pointers
    for (let level = 0; level < Config.kNumLevels; level++) {
      if (
        !!this.compactPointers[level] &&
        this.compactPointers[level].length !== 0
      ) {
        const key = new InternalKey();
        key.decodeFrom(this.compactPointers[level]);
        edit.setCompactPointer(level, key);
      }
    }

    // Save files
    for (let level = 0; level < Config.kNumLevels; level++) {
      const files: FileMetaData[] = this._current.files[level];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        edit.addFile(level, f.number, f.fileSize, f.smallest, f.largest);
      }
    }

    const record = VersionEditRecord.add(edit);
    const status = new Status(writer.addRecord(record));
    return status;
  }

  private async writeCurrentFile(
    dbpath: string,
    manifestFileNumber: number,
  ): Promise<void> {
    const currentFilename = getCurrentFilename(dbpath);
    let manifestFilename = getManifestFilename(dbpath, manifestFileNumber);
    assert(manifestFilename.startsWith(dbpath + "/"));
    manifestFilename = manifestFilename.substr(dbpath.length + 1);
    await this._options.env.writeFile(currentFilename, manifestFilename + "\n");
  }

  public pickCompaction(): Compaction | void {
    // We prefer compactions triggered by too much data in a level over
    // the compactions triggered by seeks.
    const shouldSizeCompaction = this._current.compactionScore >= 1;
    const shouldSeekCompaction = !!this._current.fileToCompact;
    let c: Compaction;
    let level: number;
    if (shouldSizeCompaction) {
      level = this._current.compactionLevel;
      assert(level >= 0);
      assert(level + 1 < Config.kNumLevels);
      c = new Compaction(this._options, level);

      for (const f of this._current.files[level]) {
        if (
          !this.compactPointers[level] ||
          this.compactPointers[level].length === 0 ||
          this.internalKeyComparator.compare(
            f.largest,
            this.compactPointers[level],
          ) > 0
        ) {
          c.inputs[0].push(f);
          break;
        }
      }
      if (c.inputs[0].length === 0) {
        c.inputs[0].push(this._current.files[level][0]);
      }
    } else if (shouldSeekCompaction) {
      level = this._current.fileToCompactLevel;
      c = new Compaction(this._options, level);
      c.inputs[0].push(this._current.fileToCompact);
    } else {
      return;
    }

    c.inputVersion = this.current;
    c.inputVersion.ref();

    if (level === 0) {
      const smallest = new InternalKey();
      const largest = new InternalKey();
      this.getRange(c.inputs[0], smallest, largest);
      // Note that the next call will discard the file we placed in
      // c->inputs_[0] earlier and replace it with an overlapping set
      // which will include the picked file.
      c.inputs[0] = this._current.getOverlappingInputs(0, smallest, largest);
      assert(c.inputs[0].length > 0);
    }
    this.setupOtherInputs(c);
    return c;
  }

  /**
   * Stores the minimal range that covers all entries in inputs in
   * smallest, *largest.
   * REQUIRES: inputs is not empty
   */
  private getRange(
    inputs: FileMetaData[],
    smallest: InternalKey,
    largest: InternalKey,
  ): void {
    assert(inputs.length > 0);
    smallest.clear();
    largest.clear();
    for (let i = 0; i < inputs.length; i++) {
      const fileMetaData = inputs[i];
      if (i === 0) {
        smallest.buffer = fileMetaData.smallest.buffer;
        largest.buffer = fileMetaData.largest.buffer;
      } else {
        if (
          this.internalKeyComparator.compare(fileMetaData.smallest, smallest) <
          0
        ) {
          smallest.buffer = fileMetaData.smallest.buffer;
        }
        if (
          this.internalKeyComparator.compare(fileMetaData.largest, largest) > 0
        ) {
          largest.buffer = fileMetaData.largest.buffer;
        }
      }
    }
  }

  /**
   * Stores the minimal range that covers all entries in inputs1 and inputs2
   * in *smallest, *largest.
   * REQUIRES: inputs is not empty
   */
  private getRange2(
    inputs1: FileMetaData[],
    inputs2: FileMetaData[],
    smallest: InternalKey,
    largest: InternalKey,
  ): void {
    const all = inputs1.concat(inputs2);
    this.getRange(all, smallest, largest);
  }

  // Finds the largest key in a vector of files. Returns true if files it not
  // empty.
  private findLargestKey(
    icmp: InternalKeyComparator,
    files: FileMetaData[],
    largestKey: InternalKey,
  ): boolean {
    if (files.length === 0) return false;
    largestKey.buffer = files[0].largest.buffer;
    for (let i = 0; i < files.length; i++) {
      const f: FileMetaData = files[i];
      if (icmp.compare(f.largest, largestKey) > 0) {
        largestKey.buffer = f.largest.buffer;
      }
    }
    return true;
  }

  // Extracts the largest file b1 from |compaction_files| and then searches for a
  // b2 in |level_files| for which user_key(u1) = user_key(l2). If it finds such a
  // file b2 (known as a boundary file) it adds it to |compaction_files| and then
  // searches again using this new upper bound.
  //
  // If there are two blocks, b1=(l1, u1) and b2=(l2, u2) and
  // user_key(u1) = user_key(l2), and if we compact b1 but not b2 then a
  // subsequent get operation will yield an incorrect result because it will
  // return the record from b2 in level i rather than from b1 because it searches
  // level by level for records matching the supplied user key.
  //
  // parameters:
  //   in     level_files:      List of files to search for boundary files.
  //   in/out compaction_files: List of files to extend by adding boundary files.
  private addBoundaryInputs(
    icmp: InternalKeyComparator,
    levelFiles: FileMetaData[],
    compactionFiles: FileMetaData[],
  ): void {
    let largestKey = new InternalKey();
    if (!this.findLargestKey(icmp, compactionFiles, largestKey)) {
      return;
    }
    while (true) {
      const smallestBoundaryFile = this.findSmallestBoundaryFile(
        icmp,
        levelFiles,
        largestKey,
      );
      if (!smallestBoundaryFile) break;
      largestKey = smallestBoundaryFile.largest;
      compactionFiles.push(smallestBoundaryFile);
    }
  }

  // Finds minimum file b2=(l2, u2) in level file for which l2 > u1 and
  // user_key(l2) = user_key(u1)
  public findSmallestBoundaryFile(
    icmp: InternalKeyComparator,
    levelFiles: FileMetaData[],
    largestKey: InternalKey,
  ): FileMetaData {
    const userComparator = icmp.userComparator;
    let smallestBoundaryFile!: FileMetaData;
    for (let i = 0; i < levelFiles.length; i++) {
      const f = levelFiles[i];
      if (
        icmp.compare(f.smallest, largestKey) > 0 &&
        userComparator.compare(f.smallest.userKey, largestKey.userKey) === 0
      ) {
        if (
          !smallestBoundaryFile ||
          icmp.compare(f.smallest, smallestBoundaryFile.smallest) < 0
        ) {
          smallestBoundaryFile = f;
        }
      }
    }

    return smallestBoundaryFile;
  }

  public setupOtherInputs(c: Compaction): void {
    const level = c.level;
    let smallest = new InternalKey();
    let largest = new InternalKey();
    this.addBoundaryInputs(
      this.internalKeyComparator,
      this._current.files[level],
      c.inputs[0],
    );
    this.getRange(c.inputs[0], smallest, largest);
    c.inputs[1] = this.current.getOverlappingInputs(
      level + 1,
      smallest,
      largest,
    );
    const allStart = new InternalKey();
    const allLimit = new InternalKey();
    this.getRange2(c.inputs[0], c.inputs[1], allStart, allLimit);
    if (c.inputs.length > 0) {
      const expand0 = this.current.getOverlappingInputs(
        level,
        allStart,
        allLimit,
      );
      this.addBoundaryInputs(
        this.internalKeyComparator,
        this._current.files[level],
        expand0,
      );
      const input0Size = this.getTotalBytes(c.inputs[0]);
      const input1Size = this.getTotalBytes(c.inputs[1]);
      const expand0Size = this.getTotalBytes(expand0);
      if (
        expand0.length > c.inputs[0].length &&
        input1Size + expand0Size <
          getExpandedCompactionByteSizeLimit(this._options)
      ) {
        const newStart = new InternalKey();
        const newLimit = new InternalKey();
        this.getRange(expand0, newStart, newLimit);
        const expand1 = this._current.getOverlappingInputs(
          level + 1,
          newStart,
          newLimit,
        );
        if (expand1.length === c.inputs[1].length) {
          this._options.log(
            `Expanding@${level} ${c.inputs[0].length}+${c.inputs[1].length}` +
              ` (${input0Size}+${input1Size} bytes) to ${expand0Size}` +
              `+${expand1.length} (${expand0Size}+${input1Size} bytes)`,
          );

          smallest = newStart;
          largest = newLimit;
          c.inputs[0] = expand0;
          c.inputs[1] = expand1;
          this.getRange2(c.inputs[0], c.inputs[1], allStart, allLimit);
        }
      }
    }

    // Compute the set of grandparent files that overlap this compaction
    // (parent == level+1; grandparent == level+2)
    if (level + 2 < Config.kNumLevels) {
      c.grandparents = this._current.getOverlappingInputs(
        level + 2,
        allStart,
        allLimit,
      );
    }

    // Update the place where we will do the next compaction for this level.
    // We update this immediately instead of waiting for the VersionEdit
    // to be applied so that if the compaction fails, we will try a different
    // key range next time.
    this.compactPointers[level] = new Slice(largest.buffer);
    c.edit.compactPointers.push({ level, internalKey: largest });
  }

  public addLiveFiles(live: Set<number>): void {
    for (
      let ver = this._dummyVersions.next;
      ver != this._dummyVersions;
      ver = ver.next
    ) {
      for (let level = 0; level < Config.kNumLevels; level++) {
        const files = ver.files[level];
        for (let i = 0; i < files.length; i++) {
          live.add(files[i].number);
        }
      }
    }
  }

  // Create an iterator that reads over the compaction
  // inputs(which includes 2 levels) for "currentCompaction".
  public async *makeInputIterator(
    currentCompaction: Compaction,
  ): AsyncIterableIterator<Entry> {
    let num = 0;
    const options = {} as ReadOptions;

    // Level-0 files have to be merged together.  For other levels,
    // we will make a concatenating iterator per level.
    // TODO(opt): use concatenating iterator for level-0 if there is no overlap
    const space =
      currentCompaction.level === 0
        ? currentCompaction.inputs[0].length + 1
        : 2;
    const list: AsyncIterableIterator<Entry>[] = Array.from({ length: space });
    for (let which = 0; which < 2; which++) {
      if (currentCompaction.inputs[which].length > 0) {
        if (currentCompaction.level + which === 0) {
          // currentCompaction.level === 0 && which === 0
          const files = currentCompaction.inputs[which];
          for (let i = 0; i < files.length; i++) {
            list[num++] = this.tableCache.entryIterator(
              options,
              files[i].number,
              files[i].fileSize,
            );
          }
        } else {
          // Create concatenating iterator for the files from this level
          const files = currentCompaction.inputs[which];
          list[num++] = this.levelFileEntryIterator(files);
        }
      }
    }

    assert(num <= space);
    const merger = new Merger(this.internalKeyComparator, list, num);
    yield* merger.iterator();
  }

  private async *levelFileEntryIterator(
    files: FileMetaData[],
  ): AsyncIterableIterator<Entry> {
    const options = {} as ReadOptions;

    for (const fileEntry of Version.levelFileNumIterator(
      this.internalKeyComparator,
      files,
    )) {
      const fileNumber = decodeFixed64(fileEntry.value.buffer.slice(0, 8));
      const fileSize = decodeFixed64(fileEntry.value.buffer.slice(8));
      yield* this.tableCache.entryIterator(
        options,
        Number(fileNumber),
        Number(fileSize),
      );
    }
  }
}
