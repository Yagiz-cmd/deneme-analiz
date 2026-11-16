const encoder = new TextEncoder()

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function paragraph(text, { size = 20, bold = false, color = '243247', before = 0, after = 100 } = {}) {
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Aptos"/><w:sz w:val="${size}"/><w:color w:val="${color}"/>${bold ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`
}

function tableCell(text, { header = false, width = 1800, align = 'left' } = {}) {
  const fill = header ? '<w:shd w:fill="E8EEF7" w:val="clear"/>' : ''
  const bold = header ? '<w:b/>' : ''
  const color = header ? '1E3A5F' : '243247'
  const alignment = align === 'right' ? '<w:jc w:val="right"/>' : ''
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${fill}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:before="40" w:after="40"/>${alignment}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="17"/><w:color w:val="${color}"/>${bold}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p></w:tc>`
}

function makeTable(headers, rows, rightAlignedColumns = []) {
  const columns = Math.max(1, headers.length)
  const width = Math.floor(9360 / columns)
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('')
  const border = '<w:tblBorders><w:top w:val="single" w:sz="5" w:color="D7E0EB"/><w:left w:val="single" w:sz="5" w:color="D7E0EB"/><w:bottom w:val="single" w:sz="5" w:color="D7E0EB"/><w:right w:val="single" w:sz="5" w:color="D7E0EB"/><w:insideH w:val="single" w:sz="4" w:color="E5EAF1"/><w:insideV w:val="single" w:sz="4" w:color="E5EAF1"/></w:tblBorders>'
  const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map((value, index) => tableCell(value, { header: true, width, align: rightAlignedColumns.includes(index) ? 'right' : 'left' })).join('')}</w:tr>`
  const bodyRows = rows.map((row) => `<w:tr>${row.map((value, index) => tableCell(value, { width, align: rightAlignedColumns.includes(index) ? 'right' : 'left' })).join('')}</w:tr>`).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/>${border}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>`
}

function deltaText(value) {
  if (value === null || value === undefined) return '—'
  return value > 0 ? `+${value}` : String(value)
}

function formattedDate(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number)
  if (!year || !month || !day) return dateKey || '—'
  return new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(year, month - 1, day))
}

function buildDocumentXml(report) {
  const body = []
  body.push(paragraph('DENEME ANALİZİ', { size: 15, bold: true, color: '55708F', after: 70 }))
  body.push(paragraph(`${report.monthLabel} Aylık Raporu`, { size: 34, bold: true, color: '17365D', after: 90 }))
  body.push(paragraph(`Oluşturulma tarihi: ${new Intl.DateTimeFormat('tr-TR', { dateStyle: 'long' }).format(new Date(report.generatedAt || Date.now()))}`, { size: 18, color: '66758A', after: 260 }))

  body.push(paragraph('Genel özet', { size: 25, bold: true, color: '17365D', before: 100, after: 100 }))
  body.push(makeTable(
    ['Toplam deneme', 'Doğru', 'Yanlış', 'Boş'],
    [[report.summary.examCount, report.summary.correct, report.summary.wrong, report.summary.blank].map(String)],
    [0, 1, 2, 3],
  ))
  body.push(paragraph('Net bilgisi yalnızca her denemenin kendi satırında gösterilir.', { size: 16, color: '66758A', before: 100, after: 220 }))

  body.push(paragraph('Ders bazında performans', { size: 25, bold: true, color: '17365D', before: 120, after: 100 }))
  body.push(makeTable(
    ['Ders', 'Deneme', 'Doğru', 'Yanlış', 'Boş'],
    report.subjects.map((item) => [item.subject, item.examCount, item.correct, item.wrong, item.blank].map(String)),
    [1, 2, 3, 4],
  ))

  body.push(paragraph('Haftalık değişim', { size: 25, bold: true, color: '17365D', before: 260, after: 100 }))
  body.push(makeTable(
    ['Dönem', 'Deneme', 'Doğru', 'Yanlış', 'Boş'],
    report.weeklyTrend.map((week) => [
      week.label,
      String(week.examCount),
      String(week.correct),
      String(week.wrong),
      String(week.blank),
    ]),
    [1, 2, 3, 4],
  ))
  body.push(paragraph('Önceki çalışma haftasına göre fark', { size: 19, bold: true, color: '284B73', before: 130, after: 70 }))
  body.push(makeTable(
    ['Dönem', 'Δ Deneme', 'Δ Doğru', 'Δ Yanlış', 'Δ Boş'],
    report.weeklyTrend.map((week) => [
      week.label,
      deltaText(week.change?.examCount),
      deltaText(week.change?.correct),
      deltaText(week.change?.wrong),
      deltaText(week.change?.blank),
    ]),
    [1, 2, 3, 4],
  ))
  body.push(paragraph(report.weeklyNote, { size: 15, color: '66758A', before: 90, after: 220 }))

  body.push(paragraph('Zorlanılan konular', { size: 25, bold: true, color: '17365D', before: 120, after: 110 }))
  report.subjects.forEach((subject) => {
    body.push(paragraph(subject.subject, { size: 21, bold: true, color: '284B73', before: 140, after: 80 }))
    if (!subject.examCount) {
      body.push(paragraph('Bu ay bu branşta deneme kaydı yok.', { size: 17, color: '66758A', after: 100 }))
    } else if (!subject.topics.length) {
      body.push(paragraph('Konu bazlı yanlış veya boş kaydı bulunmuyor.', { size: 17, color: '66758A', after: 100 }))
    } else {
      body.push(makeTable(
        ['Konu', 'Yanlış', 'Boş', 'Toplam'],
        subject.topics.map((topic) => [topic.name, topic.wrong, topic.blank, topic.total].map(String)),
        [1, 2, 3],
      ))
    }
  })

  body.push(paragraph('Deneme kayıtları', { size: 25, bold: true, color: '17365D', before: 260, after: 100 }))
  body.push(makeTable(
    ['Tarih', 'Ders', 'Deneme adı', 'Net', 'Doğru', 'Yanlış', 'Boş'],
    report.exams.map((exam) => [
      formattedDate(exam.date),
      exam.subject,
      exam.name,
      new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(exam.net),
      String(exam.correct),
      String(exam.wrong),
      String(exam.blank),
    ]),
    [3, 4, 5, 6],
  ))

  body.push(paragraph('Rapor, Deneme Analiz uygulamasında kayıtlı verilerden oluşturulmuştur.', { size: 15, color: '8290A2', before: 260, after: 0 }))

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900" w:header="450" w:footer="450" w:gutter="0"/></w:sectPr></w:body></w:document>`
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let k = 0; k < 8; k += 1) value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1)
    table[n] = value >>> 0
  }
  return table
})()

function crc32(bytes) {
  let crc = 0xFFFFFFFF
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function uint16(value) {
  const array = new Uint8Array(2)
  new DataView(array.buffer).setUint16(0, value, true)
  return array
}

function uint32(value) {
  const array = new Uint8Array(4)
  new DataView(array.buffer).setUint32(0, value >>> 0, true)
  return array
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function makeZip(files) {
  const localParts = []
  const centralParts = []
  let localOffset = 0
  const dosDate = 0x0021 // 1980-01-01

  for (const file of files) {
    const name = encoder.encode(file.name)
    const data = encoder.encode(file.content)
    const checksum = crc32(data)
    const localHeader = concatBytes([
      uint32(0x04034B50), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(dosDate),
      uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), name,
    ])
    localParts.push(localHeader, data)

    const centralHeader = concatBytes([
      uint32(0x02014B50), uint16(20), uint16(20), uint16(0x0800), uint16(0), uint16(0), uint16(dosDate),
      uint32(checksum), uint32(data.length), uint32(data.length), uint16(name.length), uint16(0), uint16(0),
      uint16(0), uint16(0), uint32(0), uint32(localOffset), name,
    ])
    centralParts.push(centralHeader)
    localOffset += localHeader.length + data.length
  }

  const centralDirectory = concatBytes(centralParts)
  const localData = concatBytes(localParts)
  const endRecord = concatBytes([
    uint32(0x06054B50), uint16(0), uint16(0), uint16(files.length), uint16(files.length),
    uint32(centralDirectory.length), uint32(localData.length), uint16(0),
  ])
  return concatBytes([localData, centralDirectory, endRecord])
}

export function createMonthlyReportDocx(report) {
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  const relationships = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  const bytes = makeZip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: relationships },
    { name: 'word/document.xml', content: buildDocumentXml(report) },
  ])
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
}

export function downloadMonthlyReportDocx(report) {
  const blob = createMonthlyReportDocx(report)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `Deneme-Analiz-${report.monthKey}-Aylik-Rapor.docx`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}
