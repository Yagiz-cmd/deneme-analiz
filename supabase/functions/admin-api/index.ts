import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'

const jsonHeaders = {
  ...corsHeaders,
  'Content-Type': 'application/json; charset=utf-8',
}

const allowedSubjects = new Set([
  'AYT Matematik',
  'AYT Fizik',
  'AYT Kimya',
  'AYT Biyoloji',
  'TYT Matematik',
  'TYT Türkçe',
  'TYT Fen',
  'TYT Sosyal',
])

const encoder = new TextEncoder()

function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: jsonHeaders })
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function importHmacKey(secret: string, usages: KeyUsage[]) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  )
}

async function signAdminToken(secret: string) {
  const now = Math.floor(Date.now() / 1000)
  const header = base64UrlEncode(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })))
  const payload = base64UrlEncode(encoder.encode(JSON.stringify({
    iss: 'deneme-analiz-admin',
    role: 'admin',
    iat: now,
    exp: now + (6 * 60 * 60),
  })))
  const unsigned = `${header}.${payload}`
  const key = await importHmacKey(secret, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(unsigned))
  return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  let difference = leftBytes.length ^ rightBytes.length
  const length = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return difference === 0
}

async function verifyAdminToken(token: string, secret: string) {
  const parts = token.split('.')
  if (parts.length !== 3) return false

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])))
    if (payload?.iss !== 'deneme-analiz-admin' || payload?.role !== 'admin') return false
    if (!Number.isInteger(payload?.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return false

    const key = await importHmacKey(secret, ['verify'])
    return await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlDecode(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    )
  } catch {
    return false
  }
}

function getServiceKey() {
  // Supabase eski service-role değişkenini de yeni secret-key haritasını da destekle.
  const legacyKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (legacyKey) return legacyKey

  const secretKeysText = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (!secretKeysText) return ''

  try {
    const secretKeys = JSON.parse(secretKeysText) as Record<string, string>
    return secretKeys.default || Object.values(secretKeys).find((value) => typeof value === 'string') || ''
  } catch {
    return ''
  }
}

function parseNonNegativeInteger(value: unknown, fieldName: string, max = 10000) {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numberValue) || numberValue < 0 || numberValue > max) {
    throw new Error(`${fieldName} sıfır ile ${max} arasında bir tam sayı olmalı.`)
  }
  return numberValue
}

function parseFileSizeBytes(value: unknown) {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
    throw new Error('Fotoğraf boyutu pozitif ve güvenli bir tam sayı olmalı.')
  }
  return numberValue
}

function isValidDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

async function handleLogin(password: unknown, adminPassword: string, tokenSecret: string) {
  if (typeof password !== 'string' || !constantTimeEqual(password, adminPassword)) {
    return jsonResponse({ ok: false, error: 'Yönetici şifresi hatalı.' }, 401)
  }

  const token = await signAdminToken(tokenSecret)
  return jsonResponse({ ok: true, token, expires_in: 21600 })
}

// createClient generic return type must be captured from a concrete factory.
// Using ReturnType<typeof createClient> directly erases its generic parameters
// and can make table row types resolve to `never` in the Supabase JS v2 types.
function createAdminClient(projectUrl: string, serviceKey: string) {
  return createClient(projectUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

type AdminClient = ReturnType<typeof createAdminClient>

async function createExam(adminClient: AdminClient, body: Record<string, unknown>) {
  const examInput = body.exam as Record<string, unknown> | undefined
  if (!examInput || typeof examInput !== 'object') {
    return jsonResponse({ ok: false, error: 'Deneme bilgileri eksik.' }, 400)
  }

  const subject = String(examInput.subject ?? '')
  const title = String(examInput.title ?? '').trim()
  const examDate = String(examInput.exam_date ?? '')

  if (!allowedSubjects.has(subject)) {
    return jsonResponse({ ok: false, error: 'Geçerli bir ders seçmelisin.' }, 400)
  }
  if (!title || title.length > 120) {
    return jsonResponse({ ok: false, error: 'Deneme adı 1–120 karakter arasında olmalı.' }, 400)
  }
  if (!isValidDate(examDate)) {
    return jsonResponse({ ok: false, error: 'Geçerli bir deneme tarihi seçmelisin.' }, 400)
  }

  let correctCount: number
  let wrongCount: number
  let blankCount: number
  try {
    correctCount = parseNonNegativeInteger(examInput.correct_count, 'Doğru sayısı')
    wrongCount = parseNonNegativeInteger(examInput.wrong_count, 'Yanlış sayısı')
    blankCount = parseNonNegativeInteger(examInput.blank_count, 'Boş sayısı')
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : 'Soru sayıları geçersiz.' }, 400)
  }

  const rawTopics = Array.isArray(body.topics) ? body.topics : []
  const rawQuestions = Array.isArray(body.questions) ? body.questions : []
  if (rawTopics.length > 100 || rawQuestions.length > 150) {
    return jsonResponse({ ok: false, error: 'Bir denemeye en fazla 100 konu ve 150 soru kaydı eklenebilir.' }, 400)
  }

  const topicsByKey = new Map<string, { topic_name: string; wrong_count: number; blank_count: number }>()
  try {
    for (const rawTopic of rawTopics) {
      const topic = rawTopic as Record<string, unknown>
      const topicName = String(topic.topic_name ?? '').trim()
      if (!topicName) continue
      if (topicName.length > 120) throw new Error('Konu adı en fazla 120 karakter olabilir.')
      const topicWrong = parseNonNegativeInteger(topic.wrong_count ?? 0, 'Konu yanlış sayısı')
      const topicBlank = parseNonNegativeInteger(topic.blank_count ?? 0, 'Konu boş sayısı')
      const key = topicName.toLocaleLowerCase('tr-TR')
      const current = topicsByKey.get(key)
      if (current) {
        current.wrong_count += topicWrong
        current.blank_count += topicBlank
      } else {
        topicsByKey.set(key, { topic_name: topicName, wrong_count: topicWrong, blank_count: topicBlank })
      }
    }
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : 'Konu bilgileri geçersiz.' }, 400)
  }

  const questionRows: Array<Record<string, unknown>> = []
  try {
    for (const rawQuestion of rawQuestions) {
      const question = rawQuestion as Record<string, unknown>
      const status = String(question.status ?? '')
      if (status !== 'wrong' && status !== 'blank') throw new Error('Soru durumu yanlış veya boş olmalı.')

      const rawNumber = question.question_number
      const questionNumber = rawNumber === null || rawNumber === undefined || rawNumber === ''
        ? null
        : parseNonNegativeInteger(rawNumber, 'Soru numarası', 1000)
      if (questionNumber === 0) throw new Error('Soru numarası 1 veya daha büyük olmalı.')

      const topicName = String(question.topic_name ?? '').trim()
      const errorType = String(question.error_type ?? '').trim()
      const note = String(question.note ?? '').trim()
      const clientRef = String(question.client_ref ?? '').trim()
      if (!clientRef || clientRef.length > 100) throw new Error('Soru eşleştirme anahtarı geçersiz.')
      if (topicName.length > 120 || errorType.length > 100 || note.length > 2000) {
        throw new Error('Soru konusu, hata nedeni veya not alanı izin verilen uzunluğu aşıyor.')
      }

      questionRows.push({
        client_ref: clientRef,
        question_number: questionNumber,
        topic_name: topicName,
        status,
        error_type: errorType,
        note,
        needs_review: Boolean(question.needs_review),
      })
    }
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : 'Soru bilgileri geçersiz.' }, 400)
  }

  const { data: examRow, error: examInsertError } = await adminClient
    .from('da_exams')
    .insert({
      subject,
      title,
      exam_date: examDate,
      correct_count: correctCount,
      wrong_count: wrongCount,
      blank_count: blankCount,
      notes: String(examInput.notes ?? '').trim().slice(0, 4000),
    })
    .select('id, subject, title, exam_date, correct_count, wrong_count, blank_count, net, notes, created_at')
    .single()

  if (examInsertError || !examRow) {
    console.error('da_exams insert error:', examInsertError)
    return jsonResponse({ ok: false, error: examInsertError?.message || 'Deneme ana kaydı oluşturulamadı.' }, 500)
  }

  const topicRows = [...topicsByKey.values()].map((topic) => ({ ...topic, exam_id: examRow.id }))
  if (topicRows.length > 0) {
    const { error: topicInsertError } = await adminClient.from('da_topic_results').insert(topicRows)
    if (topicInsertError) {
      console.error('da_topic_results insert error:', topicInsertError)
      await adminClient.from('da_exams').delete().eq('id', examRow.id)
      return jsonResponse({ ok: false, error: `Konu kayıtları kaydedilemedi: ${topicInsertError.message}` }, 500)
    }
  }

  let insertedQuestionRefs: Array<{ id: string; client_ref: string; question_number: number | null }> = []
  if (questionRows.length > 0) {
    const rowsWithExam = questionRows.map((question) => ({ ...question, exam_id: examRow.id }))
    const { data: insertedRows, error: questionInsertError } = await adminClient
      .from('da_questions')
      .insert(rowsWithExam)
      .select('id, client_ref, question_number')
    if (questionInsertError || !insertedRows) {
      console.error('da_questions insert error:', questionInsertError)
      await adminClient.from('da_exams').delete().eq('id', examRow.id)
      return jsonResponse({ ok: false, error: `Soru kayıtları kaydedilemedi: ${questionInsertError?.message || 'Kayıt kimlikleri alınamadı.'}` }, 500)
    }
    insertedQuestionRefs = insertedRows
  }

  return jsonResponse({
    ok: true,
    exam: examRow,
    topics_saved: topicRows.length,
    questions_saved: questionRows.length,
    question_refs: insertedQuestionRefs,
  })
}

const IMAGE_BUCKET = 'da-question-images'
const MAX_DIRECT_IMAGE_BYTES = 2 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i


async function updateExam(adminClient: AdminClient, body: Record<string, unknown>) {
  const examId = String(body.exam_id ?? '')
  const examInput = body.exam as Record<string, unknown> | undefined
  if (!UUID_PATTERN.test(examId)) return jsonResponse({ ok: false, error: 'Deneme kimliği geçersiz.' }, 400)
  if (!examInput || typeof examInput !== 'object') return jsonResponse({ ok: false, error: 'Deneme bilgileri eksik.' }, 400)

  const subject = String(examInput.subject ?? '')
  const title = String(examInput.title ?? '').trim()
  const examDate = String(examInput.exam_date ?? '')
  if (!allowedSubjects.has(subject)) return jsonResponse({ ok: false, error: 'Geçerli bir ders seçmelisin.' }, 400)
  if (!title || title.length > 120) return jsonResponse({ ok: false, error: 'Deneme adı 1–120 karakter arasında olmalı.' }, 400)
  if (!isValidDate(examDate)) return jsonResponse({ ok: false, error: 'Geçerli bir deneme tarihi seçmelisin.' }, 400)

  let correctCount: number
  let wrongCount: number
  let blankCount: number
  try {
    correctCount = parseNonNegativeInteger(examInput.correct_count, 'Doğru sayısı')
    wrongCount = parseNonNegativeInteger(examInput.wrong_count, 'Yanlış sayısı')
    blankCount = parseNonNegativeInteger(examInput.blank_count, 'Boş sayısı')
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : 'Soru sayıları geçersiz.' }, 400)
  }

  const rawTopics = Array.isArray(body.topics) ? body.topics : []
  if (rawTopics.length > 100) return jsonResponse({ ok: false, error: 'Bir denemeye en fazla 100 konu eklenebilir.' }, 400)
  const topicRows: Array<{ id: string | null; topic_name: string; wrong_count: number; blank_count: number }> = []
  const topicNames = new Set<string>()
  try {
    for (const rawTopic of rawTopics) {
      const topic = rawTopic as Record<string, unknown>
      const topicName = String(topic.topic_name ?? '').trim()
      if (!topicName) continue
      if (topicName.length > 120) throw new Error('Konu adı en fazla 120 karakter olabilir.')
      const topicId = topic.id === null || topic.id === undefined || topic.id === '' ? null : String(topic.id)
      if (topicId && !UUID_PATTERN.test(topicId)) throw new Error('Konu kimliği geçersiz.')
      const topicWrong = parseNonNegativeInteger(topic.wrong_count ?? 0, 'Konu yanlış sayısı')
      const topicBlank = parseNonNegativeInteger(topic.blank_count ?? 0, 'Konu boş sayısı')
      const key = topicName.toLocaleLowerCase('tr-TR')
      if (topicNames.has(key)) throw new Error('Aynı konu adını birden fazla kez ekleyemezsin.')
      topicNames.add(key)
      topicRows.push({ id: topicId, topic_name: topicName, wrong_count: topicWrong, blank_count: topicBlank })
    }
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : 'Konu bilgileri geçersiz.' }, 400)
  }

  const { error: updateError } = await adminClient.rpc('da_update_exam_with_topics', {
    p_exam_id: examId,
    p_subject: subject,
    p_title: title,
    p_exam_date: examDate,
    p_correct_count: correctCount,
    p_wrong_count: wrongCount,
    p_blank_count: blankCount,
    p_notes: String(examInput.notes ?? '').trim().slice(0, 4000),
    p_topics: topicRows,
  })
  if (updateError) {
    console.error('da_update_exam_with_topics error:', updateError)
    return jsonResponse({ ok: false, error: `Deneme güncellenemedi: ${updateError.message}` }, 500)
  }

  const { data: updated, error: fetchError } = await adminClient.from('da_exams')
    .select('id, subject, title, exam_date, correct_count, wrong_count, blank_count, net, notes, created_at')
    .eq('id', examId)
    .single()
  if (fetchError || !updated) return jsonResponse({ ok: false, error: fetchError?.message || 'Güncellenmiş deneme okunamadı.' }, 500)
  return jsonResponse({ ok: true, exam: updated, topics_saved: topicRows.length })
}

async function setQuestionReview(adminClient: AdminClient, body: Record<string, unknown>) {
  const questionId = String(body.question_id ?? '')
  const needsReview = body.needs_review
  if (!UUID_PATTERN.test(questionId)) return jsonResponse({ ok: false, error: 'Soru kimliği geçersiz.' }, 400)
  if (typeof needsReview !== 'boolean') return jsonResponse({ ok: false, error: 'Tekrar listesi durumu geçersiz.' }, 400)

  const { data, error } = await adminClient.from('da_questions')
    .update({ needs_review: needsReview })
    .eq('id', questionId)
    .select('id, needs_review')
    .maybeSingle()
  if (error) {
    console.error('Question review update error:', error)
    return jsonResponse({ ok: false, error: `Tekrar listesi güncellenemedi: ${error.message}` }, 500)
  }
  if (!data) return jsonResponse({ ok: false, error: 'Soru kaydı bulunamadı.' }, 404)
  return jsonResponse({ ok: true, question: data })
}

async function addQuestion(adminClient: AdminClient, body: Record<string, unknown>) {
  const examId = String(body.exam_id ?? '')
  const question = body.question as Record<string, unknown> | undefined
  if (!UUID_PATTERN.test(examId)) return jsonResponse({ ok: false, error: 'Deneme kimliği geçersiz.' }, 400)
  if (!question || typeof question !== 'object') return jsonResponse({ ok: false, error: 'Soru bilgileri eksik.' }, 400)

  const { data: exam, error: examError } = await adminClient.from('da_exams')
    .select('id').eq('id', examId).single()
  if (examError || !exam) return jsonResponse({ ok: false, error: 'Soru eklenecek deneme bulunamadı.' }, 404)

  const status = String(question.status ?? 'wrong')
  if (status !== 'wrong' && status !== 'blank') return jsonResponse({ ok: false, error: 'Soru durumu yanlış veya boş olmalı.' }, 400)

  let questionNumber: number | null = null
  try {
    questionNumber = question.question_number === null || question.question_number === undefined || question.question_number === ''
      ? null
      : parseNonNegativeInteger(question.question_number, 'Soru numarası', 1000)
    if (questionNumber === 0) throw new Error('Soru numarası 1 veya daha büyük olmalı.')
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : 'Soru numarası geçersiz.' }, 400)
  }

  const topicName = String(question.topic_name ?? '').trim()
  const errorType = String(question.error_type ?? '').trim()
  const note = String(question.note ?? '').trim()
  if (topicName.length > 120 || errorType.length > 100 || note.length > 2000) {
    return jsonResponse({ ok: false, error: 'Konu, hata nedeni veya not alanı izin verilen uzunluğu aşıyor.' }, 400)
  }
  if (questionNumber === null && !topicName && !note) {
    return jsonResponse({ ok: false, error: 'En azından soru numarası, konu veya açıklama girmelisin.' }, 400)
  }

  const { data: inserted, error: insertError } = await adminClient.from('da_questions')
    .insert({
      exam_id: examId,
      question_number: questionNumber,
      topic_name: topicName,
      status,
      error_type: errorType,
      note,
      needs_review: Boolean(question.needs_review),
    })
    .select('id, exam_id, question_number, topic_name, status, error_type, note, needs_review, created_at')
    .single()

  if (insertError || !inserted) {
    console.error('da_questions add error:', insertError)
    return jsonResponse({ ok: false, error: insertError?.message || 'Soru kaydı oluşturulamadı.' }, 500)
  }
  return jsonResponse({ ok: true, question: inserted })
}

async function getQuestionForExam(adminClient: AdminClient, questionId: string) {
  return await adminClient.from('da_questions')
    .select('id, exam_id')
    .eq('id', questionId)
    .single()
}

async function getExamImages(adminClient: AdminClient, examId: string) {
  const { data: questions, error: questionsError } = await adminClient
    .from('da_questions').select('id').eq('exam_id', examId)
  if (questionsError) throw questionsError
  const questionIds = (questions || []).map((row) => row.id)
  if (!questionIds.length) return { questionIds, images: [] as Array<{ id: string; question_id: string; storage_path: string }> }
  const { data: images, error: imagesError } = await adminClient
    .from('da_question_images').select('id, question_id, storage_path').in('question_id', questionIds)
  if (imagesError) throw imagesError
  return { questionIds, images: images || [] }
}

async function removeStorageFiles(adminClient: AdminClient, paths: string[]) {
  for (let start = 0; start < paths.length; start += 100) {
    const chunk = paths.slice(start, start + 100)
    if (!chunk.length) continue
    const { error } = await adminClient.storage.from(IMAGE_BUCKET).remove(chunk)
    if (error) throw error
  }
}

async function createImageUpload(adminClient: AdminClient, body: Record<string, unknown>) {
  const questionId = String(body.question_id ?? '')
  const originalName = String(body.original_name ?? '').trim().slice(0, 255)
  const mimeType = String(body.mime_type ?? '')
  const sizeBytes = parseFileSizeBytes(body.size_bytes)
  if (!UUID_PATTERN.test(questionId)) return jsonResponse({ ok: false, error: 'Soru kimliği geçersiz.' }, 400)
  if (!originalName || !ALLOWED_IMAGE_TYPES.has(mimeType) || sizeBytes < 1) {
    return jsonResponse({ ok: false, error: 'Fotoğraf adı, türü veya boyutu geçersiz.' }, 400)
  }

  const { data: question, error: questionError } = await getQuestionForExam(adminClient, questionId)
  if (questionError || !question) return jsonResponse({ ok: false, error: 'Fotoğrafın bağlanacağı soru bulunamadı.' }, 404)

  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/png' ? 'png' : 'webp'
  const storagePath = `${question.exam_id}/${questionId}/${crypto.randomUUID()}.${extension}`
  const { data: signedUpload, error: signError } = await adminClient.storage
    .from(IMAGE_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: false })
  if (signError || !signedUpload) {
    console.error('Signed upload URL error:', signError)
    return jsonResponse({ ok: false, error: signError?.message || 'Fotoğraf yükleme bağlantısı oluşturulamadı.' }, 500)
  }

  return jsonResponse({ ok: true, path: storagePath, token: signedUpload.token })
}

async function registerQuestionImage(adminClient: AdminClient, body: Record<string, unknown>) {
  const questionId = String(body.question_id ?? '')
  const storagePath = String(body.storage_path ?? '')
  const originalName = String(body.original_name ?? '').trim().slice(0, 255)
  const mimeType = String(body.mime_type ?? '')
  const sizeBytes = parseFileSizeBytes(body.size_bytes)

  if (!UUID_PATTERN.test(questionId) || !ALLOWED_IMAGE_TYPES.has(mimeType) || !originalName || sizeBytes < 1) {
    return jsonResponse({ ok: false, error: 'Fotoğraf bilgileri geçersiz.' }, 400)
  }
  const { data: question, error: questionError } = await getQuestionForExam(adminClient, questionId)
  if (questionError || !question) return jsonResponse({ ok: false, error: 'Soru bulunamadı.' }, 404)
  const prefix = `${question.exam_id}/${questionId}/`
  if (!storagePath.startsWith(prefix) || storagePath.includes('..')) {
    return jsonResponse({ ok: false, error: 'Fotoğraf yolu bu soruya ait değil.' }, 400)
  }
  const fileName = storagePath.slice(prefix.length)
  if (!fileName || fileName.includes('/')) return jsonResponse({ ok: false, error: 'Fotoğraf dosya adı geçersiz.' }, 400)
  const { data: storedFiles, error: listError } = await adminClient.storage
    .from(IMAGE_BUCKET)
    .list(prefix.slice(0, -1), { search: fileName, limit: 100 })
  if (listError || !(storedFiles || []).some((file) => file.name === fileName)) {
    return jsonResponse({ ok: false, error: 'Yüklenen fotoğraf Storage alanında bulunamadı.' }, 404)
  }

  const { data, error } = await adminClient.from('da_question_images').insert({
    question_id: questionId,
    storage_path: storagePath,
    original_name: originalName,
    mime_type: mimeType,
    size_bytes: sizeBytes,
  }).select('id').single()

  if (error || !data) {
    console.error('Image metadata insert error:', error)
    await adminClient.storage.from(IMAGE_BUCKET).remove([storagePath])
    return jsonResponse({ ok: false, error: error?.message || 'Fotoğraf kaydı oluşturulamadı.' }, 500)
  }
  return jsonResponse({ ok: true, image_id: data.id })
}

async function uploadQuestionImageDirect(
  adminClient: AdminClient,
  body: Record<string, unknown>
) {
  const questionId = String(body.question_id ?? '')
  const originalName = String(body.original_name ?? '').trim().slice(0, 255)
  const mimeType = String(body.mime_type ?? '')
  const encoded = String(body.file_base64 ?? '')

  let sizeBytes: number

  try {
    sizeBytes = parseFileSizeBytes(body.size_bytes)
  } catch {
    return jsonResponse({ ok: false, error: 'Fotoğraf boyutu geçersiz.' }, 400)
  }

  if (!UUID_PATTERN.test(questionId)) {
    return jsonResponse({ ok: false, error: 'Soru kimliği geçersiz.' }, 400)
  }

  if (!originalName || !ALLOWED_IMAGE_TYPES.has(mimeType)) {
    return jsonResponse({ ok: false, error: 'Fotoğraf adı veya türü geçersiz.' }, 400)
  }

  if (sizeBytes > MAX_DIRECT_IMAGE_BYTES) {
    return jsonResponse({
      ok: false,
      error: 'Doğrudan yükleme için fotoğraf 2 MB sınırını aşıyor.',
    }, 413)
  }

  if (!encoded || encoded.length > Math.ceil(MAX_DIRECT_IMAGE_BYTES / 3) * 4 + 4) {
    return jsonResponse({ ok: false, error: 'Fotoğraf verisi geçersiz veya çok büyük.' }, 400)
  }

  let binary: string

  try {
    binary = atob(encoded)
  } catch {
    return jsonResponse({ ok: false, error: 'Fotoğraf verisi çözümlenemedi.' }, 400)
  }

  if (binary.length !== sizeBytes) {
    return jsonResponse({ ok: false, error: 'Fotoğraf boyutu doğrulanamadı.' }, 400)
  }

  const { data: question, error: questionError } =
    await getQuestionForExam(adminClient, questionId)

  if (questionError || !question) {
    return jsonResponse({ ok: false, error: 'Fotoğrafın bağlanacağı soru bulunamadı.' }, 404)
  }

  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }

  const extension =
    mimeType === 'image/jpeg'
      ? 'jpg'
      : mimeType === 'image/png'
        ? 'png'
        : 'webp'

  const storagePath =
    `${question.exam_id}/${questionId}/${crypto.randomUUID()}.${extension}`

  const imageBlob = new Blob([buffer], { type: mimeType })

  const { error: uploadError } = await adminClient.storage
    .from(IMAGE_BUCKET)
    .upload(storagePath, imageBlob, {
      contentType: mimeType,
      cacheControl: '3600',
      upsert: false,
    })

  if (uploadError) {
    console.error('Direct image upload error:', uploadError)

    return jsonResponse({
      ok: false,
      error: `Storage fotoğraf yükleme hatası: ${uploadError.message}`,
    }, 500)
  }

  // Var olan kayıt fonksiyonunu kullan: Storage dosyasını doğrula
  // ve da_question_images tablosuna kaydet.
  return await registerQuestionImage(adminClient, {
    question_id: questionId,
    storage_path: storagePath,
    original_name: originalName,
    mime_type: mimeType,
    size_bytes: sizeBytes,
  })
}


async function cleanupImageUpload(adminClient: AdminClient, body: Record<string, unknown>) {
  const questionId = String(body.question_id ?? '')
  const storagePath = String(body.storage_path ?? '')
  if (!UUID_PATTERN.test(questionId)) return jsonResponse({ ok: false, error: 'Soru kimliği geçersiz.' }, 400)
  const { data: question, error } = await getQuestionForExam(adminClient, questionId)
  if (error || !question) return jsonResponse({ ok: false, error: 'Soru bulunamadı.' }, 404)
  const prefix = `${question.exam_id}/${questionId}/`
  if (!storagePath.startsWith(prefix) || storagePath.includes('..')) {
    return jsonResponse({ ok: false, error: 'Dosya yolu geçersiz.' }, 400)
  }
  const { error: removeError } = await adminClient.storage.from(IMAGE_BUCKET).remove([storagePath])
  if (removeError) return jsonResponse({ ok: false, error: removeError.message }, 500)
  return jsonResponse({ ok: true })
}

async function deleteQuestionImage(adminClient: AdminClient, body: Record<string, unknown>) {
  const imageId = String(body.image_id ?? '')
  if (!UUID_PATTERN.test(imageId)) return jsonResponse({ ok: false, error: 'Fotoğraf kimliği geçersiz.' }, 400)
  const { data: image, error: imageError } = await adminClient.from('da_question_images')
    .select('id, storage_path').eq('id', imageId).single()
  if (imageError || !image) return jsonResponse({ ok: false, error: 'Fotoğraf kaydı bulunamadı.' }, 404)
  const { error: removeError } = await adminClient.storage.from(IMAGE_BUCKET).remove([image.storage_path])
  if (removeError) return jsonResponse({ ok: false, error: `Fotoğraf dosyası silinemedi: ${removeError.message}` }, 500)
  const { error: deleteError } = await adminClient.from('da_question_images').delete().eq('id', imageId)
  if (deleteError) return jsonResponse({ ok: false, error: `Dosya silindi ancak fotoğraf kaydı temizlenemedi: ${deleteError.message}` }, 500)
  return jsonResponse({ ok: true, deleted_images: 1 })
}

async function deleteExamImages(adminClient: AdminClient, examId: string) {
  const { images } = await getExamImages(adminClient, examId)
  if (!images.length) return jsonResponse({ ok: true, deleted_images: 0 })
  await removeStorageFiles(adminClient, images.map((image) => image.storage_path))
  const imageIds = images.map((image) => image.id)
  const { error } = await adminClient.from('da_question_images').delete().in('id', imageIds)
  if (error) throw error
  return jsonResponse({ ok: true, deleted_images: images.length })
}

async function deleteExam(adminClient: AdminClient, examId: string) {
  if (!UUID_PATTERN.test(examId)) return jsonResponse({ ok: false, error: 'Deneme kimliği geçersiz.' }, 400)
  const { data: exam, error: examLookupError } = await adminClient.from('da_exams')
    .select('id').eq('id', examId).single()
  if (examLookupError || !exam) return jsonResponse({ ok: false, error: 'Deneme bulunamadı.' }, 404)

  const { images } = await getExamImages(adminClient, examId)
  if (images.length) await removeStorageFiles(adminClient, images.map((image) => image.storage_path))

  const { data: deletedExam, error: deleteError } = await adminClient
    .from('da_exams')
    .delete()
    .eq('id', examId)
    .select('id')
    .maybeSingle()
  if (deleteError) {
    console.error('da_exams delete error:', deleteError)
    return jsonResponse({ ok: false, error: `Fotoğraflar silindi ancak deneme kaydı silinemedi: ${deleteError.message}` }, 500)
  }
  if (!deletedExam) {
    return jsonResponse({ ok: false, error: 'Deneme kaydı silinemedi; kayıt bulunamadı veya silme işlemi uygulanmadı.' }, 404)
  }
  return jsonResponse({ ok: true, deleted_images: images.length, deleted_exam_id: deletedExam.id })
}


const BACKUP_TABLE_CONFIG = [
  { key: 'exams', table: 'da_exams', order: 'id' },
  { key: 'topicResults', table: 'da_topic_results', order: 'id' },
  { key: 'questions', table: 'da_questions', order: 'id' },
  { key: 'questionImages', table: 'da_question_images', order: 'id' },
  { key: 'analysisNotes', table: 'da_analysis_notes', order: 'id' },
  { key: 'weeklyNotes', table: 'da_weekly_notes', order: 'week_start' },
  { key: 'dailyActivities', table: 'da_daily_activities', order: 'activity_date' },
  { key: 'monthlyReports', table: 'da_monthly_reports', order: 'month_key' },
]

async function readAllTableRows(adminClient: AdminClient, table: string, orderColumn: string) {
  const rows: Array<Record<string, unknown>> = []
  const pageSize = 500
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await adminClient.from(table)
      .select('*')
      .order(orderColumn, { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (error) throw new Error(`${table} yedeklenemedi: ${error.message}`)
    const page = (data || []) as Array<Record<string, unknown>>
    rows.push(...page)
    if (page.length < pageSize) break
    if (offset > 2_000_000) throw new Error(`${table} tablosu beklenenden fazla kayıt içeriyor.`)
  }
  return rows
}

async function listAllBucketObjects(adminClient: AdminClient) {
  const objects: Array<{ path: string; size: number; mime_type: string }> = []
  const folders = ['']
  const visited = new Set<string>()
  const pageSize = 500

  while (folders.length) {
    const folder = folders.shift() as string
    if (visited.has(folder)) continue
    visited.add(folder)

    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await adminClient.storage.from(IMAGE_BUCKET).list(folder, {
        limit: pageSize,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      })
      if (error) throw new Error(`Storage klasörü okunamadı (${folder || 'kök'}): ${error.message}`)
      const entries = data || []

      for (const entry of entries) {
        const path = folder ? `${folder}/${entry.name}` : entry.name
        if (!path || path.includes('..') || path.startsWith('/')) continue
        if (!entry.id && !entry.metadata) {
          folders.push(path)
          continue
        }

        const metadata = (entry.metadata || {}) as Record<string, unknown>
        const size = Number(metadata.size ?? metadata.contentLength ?? metadata.content_length ?? 0)
        if (!Number.isFinite(size) || size < 0) {
          throw new Error(`Storage dosya boyutu okunamadı: ${path}`)
        }
        objects.push({
          path,
          size,
          mime_type: String(metadata.mimetype ?? metadata.contentType ?? 'application/octet-stream'),
        })
      }

      if (entries.length < pageSize) break
    }
  }

  return objects.sort((left, right) => left.path.localeCompare(right.path))
}

async function createBackupSnapshot(adminClient: AdminClient) {
  const tables: Record<string, Array<Record<string, unknown>>> = {}
  for (const config of BACKUP_TABLE_CONFIG) {
    tables[config.key] = await readAllTableRows(adminClient, config.table, config.order)
  }

  const storageObjects = await listAllBucketObjects(adminClient)
  const signedStorageObjects: Array<{ path: string; size: number; mime_type: string; signed_url: string }> = []
  for (let start = 0; start < storageObjects.length; start += 50) {
    const batch = storageObjects.slice(start, start + 50)
    const { data, error } = await adminClient.storage.from(IMAGE_BUCKET)
      .createSignedUrls(batch.map((item) => item.path), 6 * 60 * 60)
    if (error) throw new Error(`Yedek görselleri için indirme bağlantısı oluşturulamadı: ${error.message}`)

    const signedRows = (data || []) as Array<{ path: string; signedUrl?: string; error?: string | null }>
    const signedByPath = new Map<string, { path: string; signedUrl?: string; error?: string | null }>(
      signedRows.map((item) => [item.path, item]),
    )
    for (const item of batch) {
      const signedItem = signedByPath.get(item.path)
      if (!signedItem?.signedUrl || signedItem.error) {
        throw new Error(`Yedek görseli için indirme bağlantısı alınamadı: ${item.path}`)
      }
      signedStorageObjects.push({ ...item, signed_url: signedItem.signedUrl })
    }
  }

  return {
    format_version: 1,
    exported_at: new Date().toISOString(),
    tables,
    storage_objects: signedStorageObjects,
  }
}

async function getStorageUsage(adminClient: AdminClient) {
  const [objects, imageRows] = await Promise.all([
    listAllBucketObjects(adminClient),
    readAllTableRows(adminClient, 'da_question_images', 'id'),
  ])

  const actualPaths = new Set(objects.map((item) => item.path))
  const registeredPaths = new Set(imageRows.map((row) => String(row.storage_path || '')))
  const unregisteredFiles = objects.filter((item) => !registeredPaths.has(item.path)).length
  const missingFiles = imageRows.filter((row) => !actualPaths.has(String(row.storage_path || ''))).length
  const totalBytes = objects.reduce((total, item) => total + item.size, 0)

  return {
    bucket: IMAGE_BUCKET,
    total_bytes: totalBytes,
    file_count: objects.length,
    registered_images: imageRows.length,
    unregistered_files: unregisteredFiles,
    missing_files: missingFiles,
    measured_at: new Date().toISOString(),
  }
}

const RESTORE_TABLES: Record<string, { table: string; conflict: string; columns: string[] }> = {
  exams: {
    table: 'da_exams', conflict: 'id',
    columns: ['id', 'subject', 'title', 'exam_date', 'correct_count', 'wrong_count', 'blank_count', 'notes', 'created_at', 'updated_at'],
  },
  topicResults: {
    table: 'da_topic_results', conflict: 'id',
    columns: ['id', 'exam_id', 'topic_name', 'wrong_count', 'blank_count', 'created_at'],
  },
  questions: {
    table: 'da_questions', conflict: 'id',
    columns: ['id', 'exam_id', 'question_number', 'topic_name', 'status', 'error_type', 'note', 'needs_review', 'created_at', 'updated_at'],
  },
  questionImages: {
    table: 'da_question_images', conflict: 'id',
    columns: ['id', 'question_id', 'storage_path', 'original_name', 'mime_type', 'size_bytes', 'created_at'],
  },
  analysisNotes: {
    table: 'da_analysis_notes', conflict: 'id',
    columns: ['id', 'content', 'updated_at'],
  },
  weeklyNotes: {
    table: 'da_weekly_notes', conflict: 'week_start',
    columns: ['week_start', 'content', 'updated_at'],
  },
  dailyActivities: {
    table: 'da_daily_activities', conflict: 'activity_date',
    columns: ['activity_date', 'content_html', 'updated_at'],
  },
  monthlyReports: {
    table: 'da_monthly_reports', conflict: 'month_key',
    columns: ['month_key', 'report_data', 'generated_at'],
  },
}

function isValidRestoreStoragePath(value: unknown) {
  if (typeof value !== 'string' || value.length > 500 || value.includes('..') || value.includes('\\') || value.startsWith('/')) return false
  const parts = value.split('/')
  if (!parts.length || parts.length > 8 || parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(part))) return false
  return /\.(jpg|jpeg|png|webp)$/i.test(parts[parts.length - 1])
}

async function exportBackupSnapshot(adminClient: AdminClient) {
  try {
    const snapshot = await createBackupSnapshot(adminClient)
    return jsonResponse({ ok: true, snapshot })
  } catch (error) {
    console.error('Backup export error:', error)
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : 'Tam yedek oluşturulamadı.' }, 500)
  }
}

async function readStorageUsage(adminClient: AdminClient) {
  try {
    const usage = await getStorageUsage(adminClient)
    return jsonResponse({ ok: true, usage })
  } catch (error) {
    console.error('Storage usage query error:', error)
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : 'Depolama kullanımı okunamadı.' }, 500)
  }
}

async function createRestoreUpload(adminClient: AdminClient, body: Record<string, unknown>) {
  const path = String(body.storage_path ?? '')
  const mimeType = String(body.mime_type ?? '')
  if (!isValidRestoreStoragePath(path) || !ALLOWED_IMAGE_TYPES.has(mimeType)) {
    return jsonResponse({ ok: false, error: 'Yedek görsel yolu veya dosya türü geçersiz.' }, 400)
  }
  const extension = path.split('/').pop()?.split('.').pop()?.toLocaleLowerCase('en-US') || ''
  const expectedExtension = mimeType === 'image/jpeg' ? ['jpg', 'jpeg'] : mimeType === 'image/png' ? ['png'] : ['webp']
  if (!expectedExtension.includes(extension)) return jsonResponse({ ok: false, error: 'Görsel uzantısı ve türü eşleşmiyor.' }, 400)

  const { data, error } = await adminClient.storage.from(IMAGE_BUCKET)
    .createSignedUploadUrl(path, { upsert: true })
  if (error || !data) {
    console.error('Restore signed upload error:', error)
    return jsonResponse({ ok: false, error: error?.message || 'Geri yükleme yükleme bağlantısı oluşturulamadı.' }, 500)
  }
  return jsonResponse({ ok: true, path, token: data.token })
}

async function clearBackupTables(adminClient: AdminClient) {
  const deletionOrder = [
    { table: 'da_question_images', column: 'id' },
    { table: 'da_topic_results', column: 'id' },
    { table: 'da_questions', column: 'id' },
    { table: 'da_exams', column: 'id' },
    { table: 'da_analysis_notes', column: 'id' },
    { table: 'da_weekly_notes', column: 'week_start' },
    { table: 'da_daily_activities', column: 'activity_date' },
    { table: 'da_monthly_reports', column: 'month_key' },
  ]

  for (const item of deletionOrder) {
    const { error } = await adminClient.from(item.table).delete().not(item.column, 'is', null)
    if (error) throw new Error(`${item.table} temizlenemedi: ${error.message}`)
  }
  return jsonResponse({ ok: true })
}

async function restoreBackupBatch(adminClient: AdminClient, body: Record<string, unknown>) {
  const tableKey = String(body.table_key ?? '')
  const config = RESTORE_TABLES[tableKey]
  const rawRows = Array.isArray(body.rows) ? body.rows : null
  if (!config || !rawRows || rawRows.length > 100) {
    return jsonResponse({ ok: false, error: 'Yedek tablo adı veya kayıt grubu geçersiz.' }, 400)
  }
  if (!rawRows.length) return jsonResponse({ ok: true, restored: 0 })

  const rows = rawRows.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Yedekte geçersiz bir kayıt bulundu.')
    const source = raw as Record<string, unknown>
    const restored: Record<string, unknown> = {}
    for (const column of config.columns) {
      if (Object.prototype.hasOwnProperty.call(source, column)) restored[column] = source[column]
    }
    return restored
  })
  const payloadBytes = new TextEncoder().encode(JSON.stringify(rows)).length
  if (payloadBytes > 2_500_000) return jsonResponse({ ok: false, error: 'Kayıt grubu 2,5 MB sınırını aşıyor; daha küçük gruplar halinde dene.' }, 413)

  const { error } = await adminClient.from(config.table).upsert(rows, { onConflict: config.conflict })
  if (error) {
    console.error(`Backup restore ${tableKey} error:`, error)
    return jsonResponse({ ok: false, error: `${config.table} geri yüklenemedi: ${error.message}` }, 500)
  }
  return jsonResponse({ ok: true, restored: rows.length })
}

async function deleteOldRestoreFiles(adminClient: AdminClient, body: Record<string, unknown>) {
  const rawPaths = Array.isArray(body.storage_paths) ? body.storage_paths : []
  if (rawPaths.length > 100 || rawPaths.some((path) => !isValidRestoreStoragePath(path))) {
    return jsonResponse({ ok: false, error: 'Silinecek eski Storage yolları geçersiz.' }, 400)
  }
  const paths = [...new Set(rawPaths as string[])]
  if (!paths.length) return jsonResponse({ ok: true, deleted: 0 })
  const { error } = await adminClient.storage.from(IMAGE_BUCKET).remove(paths)
  if (error) return jsonResponse({ ok: false, error: `Eski yedek görselleri temizlenemedi: ${error.message}` }, 500)
  return jsonResponse({ ok: true, deleted: paths.length })
}

async function verifyBackupRestore(adminClient: AdminClient) {
  const counts: Record<string, number> = {}
  for (const config of BACKUP_TABLE_CONFIG) {
    const { count, error } = await adminClient.from(config.table).select('*', { count: 'exact', head: true })
    if (error) return jsonResponse({ ok: false, error: `${config.table} doğrulanamadı: ${error.message}` }, 500)
    counts[config.key] = Number(count || 0)
  }
  const storageObjects = await listAllBucketObjects(adminClient)
  return jsonResponse({ ok: true, counts, storage_file_count: storageObjects.length })
}


async function savePermanentNote(adminClient: AdminClient, body: Record<string, unknown>) {
  const content = typeof body.content === 'string' ? body.content : ''
  if (content.length > 10000) return jsonResponse({ ok: false, error: 'Kalıcı not en fazla 10.000 karakter olabilir.' }, 400)

  const { data, error } = await adminClient.from('da_analysis_notes')
    .upsert({ id: 1, content, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    .select('id, content, updated_at')
    .single()

  if (error || !data) {
    console.error('Permanent note save error:', error)
    return jsonResponse({ ok: false, error: `Kalıcı not kaydedilemedi: ${error?.message || 'Kayıt sonucu alınamadı.'}` }, 500)
  }
  return jsonResponse({ ok: true, note: data })
}

function isValidMonthKey(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false
  const [year, month] = value.split('-').map(Number)
  return year >= 2000 && year <= 2200 && month >= 1 && month <= 12
}

function monthDateRange(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number)
  const nextMonth = new Date(Date.UTC(year, month, 1))
  return {
    start: `${monthKey}-01`,
    endExclusive: nextMonth.toISOString().slice(0, 10),
  }
}

async function saveMonthlyReport(adminClient: AdminClient, body: Record<string, unknown>) {
  const monthKey = String(body.month_key ?? '')
  const reportData = body.report_data
  if (!isValidMonthKey(monthKey)) return jsonResponse({ ok: false, error: 'Aylık rapor dönemi geçersiz.' }, 400)
  if (!reportData || typeof reportData !== 'object' || Array.isArray(reportData)) {
    return jsonResponse({ ok: false, error: 'Aylık rapor içeriği eksik.' }, 400)
  }
  const reportObject = reportData as Record<string, unknown>
  if (reportObject.monthKey !== monthKey) {
    return jsonResponse({ ok: false, error: 'Rapor içeriği ile seçilen ay eşleşmiyor.' }, 400)
  }
  const serialized = JSON.stringify(reportObject)
  if (new TextEncoder().encode(serialized).length > 2_000_000) {
    return jsonResponse({ ok: false, error: 'Aylık rapor içeriği izin verilen boyutu aşıyor.' }, 413)
  }

  const { data, error } = await adminClient.from('da_monthly_reports')
    .upsert({
      month_key: monthKey,
      report_data: reportObject,
      generated_at: new Date().toISOString(),
    }, { onConflict: 'month_key' })
    .select('month_key, report_data, generated_at')
    .single()

  if (error || !data) {
    console.error('Monthly report archive save error:', error)
    return jsonResponse({ ok: false, error: `Aylık rapor arşivlenemedi: ${error?.message || 'Kayıt sonucu alınamadı.'}` }, 500)
  }
  return jsonResponse({ ok: true, report: data })
}
async function deleteMonthlyReport(
  adminClient: AdminClient,
  body: Record<string, unknown>,
) {
  const monthKey = String(body.month_key ?? '')

  if (!isValidMonthKey(monthKey)) {
    return jsonResponse(
      { ok: false, error: 'Silinecek aylık rapor dönemi geçersiz.' },
      400,
    )
  }

  const { data, error } = await adminClient
    .from('da_monthly_reports')
    .delete()
    .eq('month_key', monthKey)
    .select('month_key')
    .maybeSingle()

  if (error) {
    console.error('Monthly report archive delete error:', error)
    return jsonResponse(
      { ok: false, error: `Aylık rapor silinemedi: ${error.message}` },
      500,
    )
  }

  if (!data) {
    return jsonResponse(
      { ok: false, error: 'Silinecek aylık rapor bulunamadı.' },
      404,
    )
  }

  return jsonResponse({
    ok: true,
    month_key: data.month_key,
  })
}
async function deleteMonthImages(adminClient: AdminClient, body: Record<string, unknown>) {
  const monthKey = String(body.month_key ?? '')
  if (!isValidMonthKey(monthKey)) return jsonResponse({ ok: false, error: 'Silinecek ay geçersiz.' }, 400)

  const { data: savedReport, error: archiveError } = await adminClient.from('da_monthly_reports')
    .select('month_key')
    .eq('month_key', monthKey)
    .maybeSingle()
  if (archiveError) {
    console.error('Month image cleanup archive check error:', archiveError)
    return jsonResponse({ ok: false, error: `Önce aylık rapor arşivi doğrulanamadı: ${archiveError.message}` }, 500)
  }
  if (!savedReport) {
    return jsonResponse({ ok: false, error: 'Görselleri silmeden önce bu ayın raporunu oluşturup arşivlemelisin.' }, 409)
  }

  const { start, endExclusive } = monthDateRange(monthKey)
  const { data: exams, error: examError } = await adminClient.from('da_exams')
    .select('id')
    .gte('exam_date', start)
    .lt('exam_date', endExclusive)
  if (examError) {
    console.error('Month image cleanup exam query error:', examError)
    return jsonResponse({ ok: false, error: `Aylık deneme kayıtları okunamadı: ${examError.message}` }, 500)
  }

  const examIds = (exams || []).map((exam) => exam.id)
  if (!examIds.length) return jsonResponse({ ok: true, month_key: monthKey, affected_exams: 0, affected_questions: 0, deleted_images: 0 })

  const questionIds: string[] = []
  for (let startIndex = 0; startIndex < examIds.length; startIndex += 200) {
    const examBatch = examIds.slice(startIndex, startIndex + 200)
    const { data: questions, error: questionError } = await adminClient.from('da_questions')
      .select('id')
      .in('exam_id', examBatch)
    if (questionError) {
      console.error('Month image cleanup question query error:', questionError)
      return jsonResponse({ ok: false, error: `Aylık soru kayıtları okunamadı: ${questionError.message}` }, 500)
    }
    questionIds.push(...(questions || []).map((question) => question.id))
  }

  const imageRows: Array<{ id: string; storage_path: string }> = []
  for (let startIndex = 0; startIndex < questionIds.length; startIndex += 200) {
    const questionBatch = questionIds.slice(startIndex, startIndex + 200)
    const { data: images, error: imageError } = await adminClient.from('da_question_images')
      .select('id, storage_path')
      .in('question_id', questionBatch)
    if (imageError) {
      console.error('Month image cleanup image query error:', imageError)
      return jsonResponse({ ok: false, error: `Aylık görsel kayıtları okunamadı: ${imageError.message}` }, 500)
    }
    imageRows.push(...(images || []))
  }

  if (imageRows.length) {
    try {
      await removeStorageFiles(adminClient, imageRows.map((image) => image.storage_path))
    } catch (error) {
      console.error('Month Storage image cleanup error:', error)
      return jsonResponse({ ok: false, error: `Görsel dosyaları Storage alanından silinemedi: ${error instanceof Error ? error.message : 'Bilinmeyen hata'}` }, 500)
    }

    for (let startIndex = 0; startIndex < imageRows.length; startIndex += 200) {
      const imageBatch = imageRows.slice(startIndex, startIndex + 200).map((image) => image.id)
      const { error: metadataDeleteError } = await adminClient.from('da_question_images')
        .delete()
        .in('id', imageBatch)
      if (metadataDeleteError) {
        console.error('Month image metadata cleanup error:', metadataDeleteError)
        return jsonResponse({ ok: false, error: `Görseller silindi ancak görsel kayıtları temizlenemedi: ${metadataDeleteError.message}` }, 500)
      }
    }
  }

  return jsonResponse({
    ok: true,
    month_key: monthKey,
    affected_exams: examIds.length,
    affected_questions: questionIds.length,
    deleted_images: imageRows.length,
  })
}

async function saveWeeklyNote(adminClient: AdminClient, body: Record<string, unknown>) {
  const weekStart = String(body.week_start ?? '')
  const content = typeof body.content === 'string' ? body.content : ''
  if (!isValidDate(weekStart)) return jsonResponse({ ok: false, error: 'Hafta başlangıç tarihi geçersiz.' }, 400)
  const weekStartDate = new Date(`${weekStart}T00:00:00.000Z`)
  if (weekStartDate.getUTCDay() !== 1) return jsonResponse({ ok: false, error: 'Hafta başlangıcı pazartesi olmalı.' }, 400)
  if (content.length > 6000) return jsonResponse({ ok: false, error: 'Haftalık not en fazla 6.000 karakter olabilir.' }, 400)

  const { data, error } = await adminClient.from('da_weekly_notes')
    .upsert({ week_start: weekStart, content, updated_at: new Date().toISOString() }, { onConflict: 'week_start' })
    .select('week_start, content, updated_at')
    .single()

  if (error || !data) {
    console.error('Weekly note save error:', error)
    return jsonResponse({ ok: false, error: `Haftalık değerlendirme kaydedilemedi: ${error?.message || 'Kayıt sonucu alınamadı.'}` }, 500)
  }
  return jsonResponse({ ok: true, note: data })
}
async function saveDailyActivity(adminClient: AdminClient, body: Record<string, unknown>) {
  const activityDate = String(body.activity_date ?? '')
  const contentHtml = typeof body.content_html === 'string' ? body.content_html : ''

  if (!isValidDate(activityDate)) {
    return jsonResponse({ ok: false, error: 'Günlük kayıt tarihi geçersiz.' }, 400)
  }

  const weekday = new Date(`${activityDate}T00:00:00.000Z`).getUTCDay()
  if (weekday === 1) {
    return jsonResponse({ ok: false, error: 'Günlük yapılanlar yalnızca Salı-Pazar günleri için kaydedilebilir.' }, 400)
  }

  if (new TextEncoder().encode(contentHtml).length > 20000) {
    return jsonResponse({ ok: false, error: 'Günlük çalışma metni 20 KB sınırını aşıyor.' }, 413)
  }

  // İçerik yalnızca yazı ve biçimlendirmeden oluşmalıdır. Aktif içerik/script kabul edilmez.
  if (/<\s*(script|iframe|object|embed|img|svg|math|video|audio)\b/i.test(contentHtml)
    || /\son[a-z]+\s*=/i.test(contentHtml)
    || /javascript\s*:/i.test(contentHtml)) {
    return jsonResponse({ ok: false, error: 'Günlük metinde izin verilmeyen HTML bulundu.' }, 400)
  }

  const { data, error } = await adminClient.from('da_daily_activities')
    .upsert({
      activity_date: activityDate,
      content_html: contentHtml,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'activity_date' })
    .select('activity_date, content_html, updated_at')
    .single()

  if (error || !data) {
    console.error('Daily activity save error:', error)
    return jsonResponse({ ok: false, error: `Günlük çalışma kaydedilemedi: ${error?.message || 'Kayıt sonucu alınamadı.'}` }, 500)
  }

  return jsonResponse({ ok: true, activity: data })
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (request.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'Yalnızca POST istekleri kabul edilir.' }, 405)
  }

  try {
    const adminPassword = Deno.env.get('ADMIN_PASSWORD') || ''
    const tokenSecret = Deno.env.get('TOKEN_SECRET') || ''
    const projectUrl = Deno.env.get('SUPABASE_URL') || ''
    const serviceKey = getServiceKey()

    if (adminPassword.length !== 10 || !tokenSecret || tokenSecret.length < 32) {
      return jsonResponse({ ok: false, error: 'Sunucu ayarlarını kontrol et: ADMIN_PASSWORD tam 10 karakter, TOKEN_SECRET en az 32 karakter olmalı.' }, 500)
    }
    if (!projectUrl || !serviceKey) {
      return jsonResponse({ ok: false, error: 'Supabase sunucu anahtarı bulunamadı. Edge Function ortam değişkenlerini kontrol et.' }, 500)
    }

    const body = await request.json() as Record<string, unknown>
    const action = String(body.action ?? '')

    if (action === 'login') {
      return await handleLogin(body.password, adminPassword, tokenSecret)
    }

    const authorization = request.headers.get('authorization') || ''
    const match = authorization.match(/^Bearer\s+(.+)$/i)
    if (!match || !(await verifyAdminToken(match[1], tokenSecret))) {
      return jsonResponse({ ok: false, error: 'Yönetici oturumu geçersiz veya süresi dolmuş. Gizli yönetici girişini yeniden yap.' }, 401)
    }

    const adminClient = createAdminClient(projectUrl, serviceKey)

    if (action === 'create_exam') return await createExam(adminClient, body)
    if (action === 'update_exam') return await updateExam(adminClient, body)
    if (action === 'set_question_review') return await setQuestionReview(adminClient, body)
    if (action === 'add_question') return await addQuestion(adminClient, body)
    if (action === 'upload_question_image_direct') {
  return await uploadQuestionImageDirect(adminClient, body)
}  
    if (action === 'create_image_upload') return await createImageUpload(adminClient, body)
    if (action === 'register_question_image') return await registerQuestionImage(adminClient, body)
    if (action === 'cleanup_image_upload') return await cleanupImageUpload(adminClient, body)
    if (action === 'delete_question_image') return await deleteQuestionImage(adminClient, body)
    if (action === 'delete_exam_images') {
      const examId = String(body.exam_id ?? '')
      if (!UUID_PATTERN.test(examId)) return jsonResponse({ ok: false, error: 'Deneme kimliği geçersiz.' }, 400)
      return await deleteExamImages(adminClient, examId)
    }
    if (action === 'delete_exam') return await deleteExam(adminClient, String(body.exam_id ?? ''))
    if (action === 'save_permanent_note') return await savePermanentNote(adminClient, body)
    if (action === 'save_weekly_note') return await saveWeeklyNote(adminClient, body)
    if (action === 'save_daily_activity') return await saveDailyActivity(adminClient, body)
    if (action === 'save_monthly_report') return await saveMonthlyReport(adminClient, body)
    if (action === 'delete_monthly_report') return await deleteMonthlyReport(adminClient, body)
    if (action === 'delete_month_images') return await deleteMonthImages(adminClient, body)
    if (action === 'get_storage_usage') return await readStorageUsage(adminClient)
    if (action === 'export_backup_snapshot') return await exportBackupSnapshot(adminClient)
    if (action === 'create_restore_upload') return await createRestoreUpload(adminClient, body)
    if (action === 'clear_backup_tables') return await clearBackupTables(adminClient)
    if (action === 'restore_backup_batch') return await restoreBackupBatch(adminClient, body)
    if (action === 'delete_old_restore_files') return await deleteOldRestoreFiles(adminClient, body)
    if (action === 'verify_backup_restore') return await verifyBackupRestore(adminClient)

    return jsonResponse({ ok: false, error: 'Bilinmeyen yönetici işlemi.' }, 400)
  } catch (error) {
    console.error('admin-api unexpected error:', error)
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : 'Beklenmeyen sunucu hatası.' }, 500)
  }
})
