const encoder = new TextEncoder()
const decoder = new TextDecoder()

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1)
    }
    table[n] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let value = 0xFFFFFFFF
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xFF] ^ (value >>> 8)
  return (value ^ 0xFFFFFFFF) >>> 0
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  const time = ((date.getHours() & 0x1F) << 11)
    | ((date.getMinutes() & 0x3F) << 5)
    | (Math.floor(date.getSeconds() / 2) & 0x1F)
  const day = ((year - 1980) << 9)
    | (((date.getMonth() + 1) & 0x0F) << 5)
    | (date.getDate() & 0x1F)
  return { time, day }
}

function assertZipName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('/') || name.includes('\\')) {
    throw new Error('Yedek içindeki dosya adı geçersiz.')
  }
  const segments = name.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Yedek içinde güvenli olmayan bir dosya yolu bulundu.')
  }
}

function makeLocalHeader(nameBytes, checksum, size, dateTime) {
  const header = new Uint8Array(30 + nameBytes.length)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x04034B50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 0x0800, true)
  view.setUint16(8, 0, true)
  view.setUint16(10, dateTime.time, true)
  view.setUint16(12, dateTime.day, true)
  view.setUint32(14, checksum, true)
  view.setUint32(18, size, true)
  view.setUint32(22, size, true)
  view.setUint16(26, nameBytes.length, true)
  view.setUint16(28, 0, true)
  header.set(nameBytes, 30)
  return header
}

function makeCentralHeader(nameBytes, checksum, size, offset, dateTime) {
  const header = new Uint8Array(46 + nameBytes.length)
  const view = new DataView(header.buffer)
  view.setUint32(0, 0x02014B50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 20, true)
  view.setUint16(8, 0x0800, true)
  view.setUint16(10, 0, true)
  view.setUint16(12, dateTime.time, true)
  view.setUint16(14, dateTime.day, true)
  view.setUint32(16, checksum, true)
  view.setUint32(20, size, true)
  view.setUint32(24, size, true)
  view.setUint16(28, nameBytes.length, true)
  view.setUint16(30, 0, true)
  view.setUint16(32, 0, true)
  view.setUint16(34, 0, true)
  view.setUint16(36, 0, true)
  view.setUint32(38, 0, true)
  view.setUint32(42, offset, true)
  header.set(nameBytes, 46)
  return header
}

export async function createBackupZip(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('Yedek dosyası boş oluşturulamaz.')
  if (entries.length > 65535) throw new Error('ZIP biçimi en fazla 65.535 dosya destekliyor.')

  const localParts = []
  const centralParts = []
  let localOffset = 0
  let centralSize = 0
  const dateTime = dosDateTime()

  for (const entry of entries) {
    assertZipName(entry.name)
    const nameBytes = encoder.encode(entry.name)
    const bytes = entry.bytes instanceof Uint8Array
      ? entry.bytes
      : entry.bytes instanceof ArrayBuffer
        ? new Uint8Array(entry.bytes)
        : new Uint8Array(await entry.bytes.arrayBuffer())

    if (bytes.byteLength > 0xFFFFFFFF || localOffset > 0xFFFFFFFF) {
      throw new Error('Yedek 4 GB sınırını aşıyor. Bu ZIP biçimi bu büyüklükte dosya oluşturamaz.')
    }

    const checksum = crc32(bytes)
    const localHeader = makeLocalHeader(nameBytes, checksum, bytes.byteLength, dateTime)
    const centralHeader = makeCentralHeader(nameBytes, checksum, bytes.byteLength, localOffset, dateTime)
    localParts.push(localHeader, bytes)
    centralParts.push(centralHeader)
    localOffset += localHeader.byteLength + bytes.byteLength
    centralSize += centralHeader.byteLength
  }

  if (localOffset + centralSize > 0xFFFFFFFF) {
    throw new Error('Yedek 4 GB sınırını aşıyor. Daha küçük bölümler halinde yedek oluşturmalısın.')
  }

  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054B50, true)
  endView.setUint16(4, 0, true)
  endView.setUint16(6, 0, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, localOffset, true)
  endView.setUint16(20, 0, true)

  return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' })
}

export async function readBackupZip(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const minimumSearchStart = Math.max(0, bytes.length - 65_557)
  let endOffset = -1

  for (let offset = bytes.length - 22; offset >= minimumSearchStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054B50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) throw new Error('Dosya geçerli bir ZIP arşivi değil veya arşiv sonu bulunamadı.')

  const totalEntries = view.getUint16(endOffset + 10, true)
  const centralSize = view.getUint32(endOffset + 12, true)
  const centralOffset = view.getUint32(endOffset + 16, true)
  if (centralOffset + centralSize > bytes.length) throw new Error('ZIP dosyasının dizin bilgisi bozuk.')

  const files = new Map()
  let cursor = centralOffset

  for (let index = 0; index < totalEntries; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014B50) throw new Error('ZIP dosyasının dosya listesi bozuk.')
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const expectedCrc = view.getUint32(cursor + 16, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localHeaderOffset = view.getUint32(cursor + 42, true)
    const nameStart = cursor + 46
    const fileName = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    cursor += 46 + nameLength + extraLength + commentLength

    if (flags & 0x0001) throw new Error('Şifrelenmiş ZIP yedekleri desteklenmiyor.')
    if (method !== 0) throw new Error('Bu dosya sıkıştırılmış ZIP biçiminde. Deneme Analiz tarafından oluşturulmuş ZIP yedeği seçmelisin.')
    if (compressedSize !== uncompressedSize) throw new Error('ZIP dosyasının boyut bilgisi tutarsız.')
    assertZipName(fileName)

    if (view.getUint32(localHeaderOffset, true) !== 0x04034B50) throw new Error('ZIP dosyasının veri başlığı bozuk.')
    const localNameLength = view.getUint16(localHeaderOffset + 26, true)
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true)
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > bytes.length) throw new Error('ZIP içindeki dosya verisi eksik.')

    const content = bytes.slice(dataStart, dataEnd)
    if (crc32(content) !== expectedCrc) throw new Error(`ZIP içindeki “${fileName}” dosyasının kontrol toplamı uyuşmuyor.`)
    files.set(fileName, content)
  }

  if (files.size !== totalEntries) throw new Error('ZIP dosya sayısı uyuşmuyor.')
  return files
}

export function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let amount = bytes / 1024
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${amount.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} ${units[index]}`
}
