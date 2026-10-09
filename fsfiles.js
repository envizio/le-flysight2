// FlySight 2 file transfer over Bluetooth. Protocol from flysight-2-firmware (FlySight/crs.c):
// commands are written to CRS_RX, replies arrive as notifications on CRS_TX, first byte is the command.
const CRS_SERVICE = '00000000-cc7a-482a-984a-7f2ed5b3e58f';
const CRS_TX = '00000001-8e22-4541-9d4c-21edae82ed19';
const CRS_RX = '00000002-8e22-4541-9d4c-21edae82ed19';
const CMD = { READ: 0x02, READ_DIR: 0x05, FILE_DATA: 0x10, FILE_INFO: 0x11, FILE_ACK: 0x12, NAK: 0xf0, ACK: 0xf1, CANCEL: 0xff };
const ATTR_DIRECTORY = 0x10;

let crs = null;   // open file-transfer channel for the current connection; app.js clears it on disconnect

async function crsOpen() {
  if (!device?.gatt.connected) throw new Error('Connect to the FlySight on the Live tab first.');
  if (crs) return crs;
  let service;
  try { service = await device.gatt.getPrimaryService(CRS_SERVICE); }
  catch (e) {
    throw new Error(e.name === 'SecurityError'
      ? 'Track downloads need a fresh permission. On the Live tab, disconnect and connect again.'
      : 'This FlySight did not offer file transfer (' + e.message + ').');
  }
  const tx = await service.getCharacteristic(CRS_TX), rx = await service.getCharacteristic(CRS_RX);
  const channel = { rx, onPacket: null, queue: Promise.resolve() };
  tx.addEventListener('characteristicvaluechanged', e => {
    const v = e.target.value;
    channel.onPacket?.(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
  });
  await tx.startNotifications();
  return crs = channel;
}

// Web Bluetooth allows one GATT write at a time, so writes are chained
function crsSend(channel, bytes) {
  channel.queue = channel.queue.then(() => channel.rx.writeValueWithoutResponse(Uint8Array.from(bytes))).catch(() => {});
}

// Send a command and feed replies to handle() until it returns a value. Fails if the FlySight goes quiet.
function crsRun(channel, command, handle, idleMs = 8000) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (settle, value) => { clearTimeout(timer); channel.onPacket = null; settle(value); };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { crsSend(channel, [CMD.CANCEL]); finish(reject, new Error('The FlySight stopped responding.')); }, idleMs);
    };
    channel.onPacket = p => {
      arm();
      if (p[0] === CMD.NAK) return finish(reject, new Error('The FlySight refused the request. If it is logging, switch it off and try again.'));
      const result = handle(p);
      if (result !== undefined) finish(resolve, result);
    };
    arm();
    crsSend(channel, command);
  });
}

const pathBytes = path => [...new TextEncoder().encode(path)];
const joinPath = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;

// Directory listing: one FILE_INFO per entry, ending with an entry whose name is empty
async function fsListDir(path) {
  const channel = await crsOpen();
  const entries = [];
  let next = 0;
  return crsRun(channel, [CMD.READ_DIR, ...pathBytes(path)], p => {
    if (p[0] !== CMD.FILE_INFO || p[1] !== (next & 0xff)) return;
    next++;
    let name = '';
    for (let i = 11; i < p.length && p[i]; i++) name += String.fromCharCode(p[i]);
    if (!name) return entries;
    entries.push({ name, size: new DataView(p.buffer).getUint32(2, true), dir: !!(p[10] & ATTR_DIRECTORY) });
  });
}

// File read: the FlySight sends numbered FILE_DATA frames and waits for each to be acknowledged,
// resending from the last acknowledged frame on timeout. An empty frame marks the end of the file.
async function fsReadFile(path, onProgress) {
  const channel = await crsOpen();
  const chunks = [];
  let next = 0, received = 0;
  const command = [CMD.READ, 0, 0, 0, 0, 0, 0, 0, 0, ...pathBytes(path)];   // offset 0, stride 0 = whole file
  await crsRun(channel, command, p => {
    if (p[0] !== CMD.FILE_DATA || p[1] !== (next & 0xff)) return;
    crsSend(channel, [CMD.FILE_ACK, p[1]]);
    next++;
    if (p.length === 2) return true;
    chunks.push(p.subarray(2));
    received += p.length - 2;
    onProgress?.(received);
  }, 10000);
  return new Blob(chunks).text();
}
