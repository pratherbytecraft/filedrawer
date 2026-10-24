// Writes a small .DS_Store file the way Finder lays one out (a "Bud1" file
// holding a B-tree of records), for testing Put Back's reader without a real
// Trash. records are [name, code, type, value]; types ustr, bool, long and
// blob. With split, the records go in two leaves under one inner node.
export type DsRecord =
  | [name: string, code: string, type: 'ustr', value: string]
  | [name: string, code: string, type: 'bool', value: boolean]
  | [name: string, code: string, type: 'long', value: number]
  | [name: string, code: string, type: 'blob', value: Buffer];

function record([name, code, type, value]: DsRecord) {
  const parts: Buffer[] = [u32(name.length), utf16(name), Buffer.from(code, 'latin1'), Buffer.from(type, 'latin1')];
  if (type === 'ustr') parts.push(u32(value.length), utf16(value));
  else if (type === 'bool') parts.push(Buffer.from([value ? 1 : 0]));
  else if (type === 'long') parts.push(u32(value));
  else if (type === 'blob') parts.push(u32(value.length), value);
  return Buffer.concat(parts);
}

function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function utf16(text: string) {
  return Buffer.from(text, 'utf16le').swap16();
}

export function dsStore(records: DsRecord[], { split = false } = {}) {
  // Blocks by id, each at a 32 byte aligned offset (counted from byte 4).
  const blocks: Buffer[] = [];
  if (split) {
    const half = Math.ceil(records.length / 2);
    const left = records.slice(0, half - 1);
    const middle = records[half - 1];
    const right = records.slice(half);
    blocks[2] = Buffer.concat([u32(0), u32(left.length), ...left.map(record)]);
    blocks[3] = Buffer.concat([u32(0), u32(right.length), ...right.map(record)]);
    blocks[4] = Buffer.concat([u32(3), u32(1), u32(2), record(middle)]);
    blocks[1] = Buffer.concat([u32(4), u32(1), u32(records.length), u32(3), u32(4096)]);
  } else {
    blocks[2] = Buffer.concat([u32(0), u32(records.length), ...records.map(record)]);
    blocks[1] = Buffer.concat([u32(2), u32(0), u32(records.length), u32(1), u32(4096)]);
  }
  const offsets: number[] = [];
  let at = 64;
  for (let id = 1; id < blocks.length; id++) {
    offsets[id] = at;
    at += Math.ceil(blocks[id].length / 32) * 32 + 32;
  }
  const rootAt = at;
  const addrs = [0];
  for (let id = 1; id < blocks.length; id++) addrs.push(offsets[id] | 5);
  const table = Buffer.alloc(4 * 256);
  addrs.forEach((a, i) => table.writeUInt32BE(a, 4 * i));
  const root = Buffer.concat([u32(addrs.length), u32(0), table, u32(1), Buffer.from([4]), Buffer.from('DSDB'), u32(1)]);
  const out = Buffer.alloc(4 + rootAt + root.length);
  out.writeUInt32BE(1, 0);
  out.write('Bud1', 4, 'latin1');
  out.writeUInt32BE(rootAt, 8);
  out.writeUInt32BE(root.length, 12);
  out.writeUInt32BE(rootAt, 16);
  for (let id = 1; id < blocks.length; id++) blocks[id].copy(out, 4 + offsets[id]);
  root.copy(out, 4 + rootAt);
  return out;
}

