/**
 * Copyright (c) 2018-present, heineiuo.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { varint } from "./DBHelper";
import BitBuffer from "./BitBuffer";
import { hash } from "./Hash";
import Slice from "./Slice";
import { Buffer } from "./Buffer";
import { FilterPolicy } from "./Options";

function bloomHash(key: Slice): number {
  return hash(key.buffer, 0xbc9f1d34);
}

/**
 * time of hash is main effect
 * best time of hash = bits number / elements number x ln2(≈0.69)
 * elements number and ln2 is predictable
 * bits number is configable
 * from past experience, bitsPerKey = 10 is best
 */
export default class BloomFilter implements FilterPolicy {
  constructor(buffer?: Buffer, bitsPerKey = 10) {
    this._offset = 0;
    this._bitsPerKey = bitsPerKey;
    const k = Math.round(bitsPerKey * 0.69);

    if (!buffer || buffer.length === 0) {
      this._buffer = Buffer.fromUnknown(varint.encode(k));
      this._bitBuffer = new BitBuffer(Buffer.alloc(Math.ceil(k / 8)));
      this._kNumber = k;
    } else {
      this._buffer = buffer;
      this._bitBuffer = new BitBuffer(buffer.slice(0, buffer.length - 1));
      this._kNumber = varint.decode(
        this._buffer.slice(this._buffer.length - 1),
      );
      if (this._kNumber !== k) {
        this._kNumber = k;
        this._buffer = Buffer.concat([
          this._buffer.slice(0, this._buffer.length - 1),
          Buffer.fromUnknown(varint.encode(k)),
        ]);
        this._bitBuffer.resizeBits(k);
      }
    }
    this._size = this._buffer.length;
  }

  private _buffer: Buffer;
  private _offset: number;
  private _size: number;
  private _kNumber: number;
  private _bitBuffer: BitBuffer;
  private _bitsPerKey: number;

  get bitsPerKey(): number {
    return this._bitsPerKey;
  }

  get bitBuffer(): BitBuffer {
    return this._bitBuffer;
  }

  get buffer(): Buffer {
    return this._buffer;
  }

  get size(): number {
    return this._size;
  }

  get kNumber(): number {
    return this._kNumber;
  }

  // Return the name of this policy.  Note that if the filter encoding
  // changes in an incompatible way, the name returned by this method
  // must be changed.  Otherwise, old incompatible filters may be
  // passed to methods of this type.
  public name(): string {
    return "leveldb.BuiltinBloomFilter2";
  }

  // keys[0,n-1] contains a list of keys (potentially with duplicates)
  // that are ordered according to the user supplied comparator.
  // Append a filter that summarizes keys[0,n-1] to *dst.
  //
  // Warning: do not change the initial contents of *dst.  Instead,
  // append the newly constructed filter to *dst.
  public putKeys(keys: Slice[], n: number): void {
    // Compute bloom filter size (in both bits and bytes)
    let bits = this.bitsPerKey * n;

    // For small n, we can see a very high false positive rate.  Fix it
    // by enforcing a minimum bloom filter length.
    if (bits < 64) bits = 64;

    const bytes = (bits + 7) / 8;
    bits = bytes * 8;

    this._bitBuffer.resizeBits(bits);
    bits = this._bitBuffer.bits;

    for (let i = 0; i < n; i++) {
      // Use double-hashing to generate a sequence of hash values.
      // See analysis in [Kirsch,Mitzenmacher 2006].
      let h = bloomHash(keys[i]);

      const delta = (h >> 17) | (h << 15);
      for (let j = 0; j < this.kNumber; j++) {
        const bitPosition = h % bits;
        this._bitBuffer.set(bitPosition, true);
        h += delta;
      }
    }
    this._buffer = Buffer.concat([
      this._bitBuffer.buffer,
      this._buffer.slice(
        this._offset + this._size - 1,
        this._offset + this._size,
      ),
    ]);
    this._size = this._buffer.length;
  }

  public keyMayMatch(key: Slice, bloomFilter: Slice): boolean {
    const filter = new BloomFilter(bloomFilter.buffer);

    if (filter.kNumber > 30) return true;
    let h = bloomHash(key);
    const delta = (h >> 17) | (h << 15);
    for (let j = 0; j < filter.kNumber; j++) {
      const bitPosition = h % filter._bitBuffer.bits;
      if (!filter._bitBuffer.get(bitPosition)) return false;
      h += delta;
    }
    return true;
  }
}
