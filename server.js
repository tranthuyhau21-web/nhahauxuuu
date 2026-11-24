const http = require('node:http')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const express = require('express')
const { Server } = require('socket.io')
const os = require('node:os')

const SMSCODE_TOKEN = 'd216281d300e42d697c7f08174575ee20080a3ad7eb377ad9c3457a3a0e7b0d0'
const GRIZZLY_API_KEY = '5f16fee0ae39b3e68550f37b4fca82ab'
const GRIZZLY_BASE_URL = 'https://api.grizzlysms.com/stubs/handler_api.php'
const DEFAULT_UPSTREAM = 'https://api.smscode.gg/v2'
const MAX_BODY_BYTES = 65536

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/smscode.js', ['smscode.js', 'text/javascript; charset=utf-8']],
  ['/searchable-select.js', ['searchable-select.js', 'text/javascript; charset=utf-8']],
  ['/order-time.js', ['order-time.js', 'text/javascript; charset=utf-8']],
  ['/polling-registry.js', ['polling-registry.js', 'text/javascript; charset=utf-8']],
])

class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function errorPayload(code, message) {
  return { success: false, error: { code, message } }
}

function validateSingleInteger(searchParams, name, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const values = searchParams.getAll(name)
  if (values.length !== 1 || !/^\d+$/.test(values[0])) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${name} phải là số nguyên hợp lệ.`)
  }
  const value = Number(values[0])
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, 'VALIDATION_ERROR', `${name} nằm ngoài phạm vi cho phép.`)
  }
  return value
}

function rejectUnknownQuery(searchParams, allowed) {
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `Tham số không được hỗ trợ: ${key}.`)
    }
  }
}

function buildQuery(values) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    query.set(key, String(value))
  }
  return query.toString()
}

function matchApiRoute(method, url) {
  if (url.pathname === '/api/catalog/countries') {
    if (method !== 'GET') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Phương thức không được hỗ trợ.')
    }
    rejectUnknownQuery(url.searchParams, new Set())
    return { upstreamPath: '/catalog/countries' }
  }

  if (url.pathname === '/api/catalog/services') {
    if (method !== 'GET') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Phương thức không được hỗ trợ.')
    }
    rejectUnknownQuery(url.searchParams, new Set(['country_id']))
    const countryId = validateSingleInteger(url.searchParams, 'country_id')
    return {
      upstreamPath: `/catalog/services?${buildQuery({ country_id: countryId })}`,
    }
  }

  if (url.pathname === '/api/catalog/products') {
    if (method !== 'GET') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Phương thức không được hỗ trợ.')
    }

    const allowed = new Set(['country_id', 'platform_id', 'sort', 'limit', 'page'])
    rejectUnknownQuery(url.searchParams, allowed)

    const countryId = validateSingleInteger(url.searchParams, 'country_id')
    const platformId = validateSingleInteger(url.searchParams, 'platform_id')

    const sortValues = url.searchParams.getAll('sort')
    const sort = sortValues.length === 0 ? 'price_asc' : sortValues[0]

    if (
      sortValues.length > 1 ||
      !['price_asc', 'price_desc', 'available_asc', 'available_desc', 'name_asc', 'name_desc'].includes(sort)
    ) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'sort không hợp lệ.')
    }

    const limit = url.searchParams.has('limit')
      ? validateSingleInteger(url.searchParams, 'limit', { max: 10000 })
      : 10000

    const page = url.searchParams.has('page')
      ? validateSingleInteger(url.searchParams, 'page')
      : 1

    return {
      upstreamPath: `/catalog/products?${buildQuery({
        country_id: countryId,
        platform_id: platformId,
        sort,
        limit,
        page,
      })}`,
    }
  }

  if (url.pathname === '/api/orders/create') {
    if (method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Phương thức không được hỗ trợ.')
    }
    rejectUnknownQuery(url.searchParams, new Set())
    return { upstreamPath: '/orders/create', hasBody: true }
  }

  if (url.pathname.startsWith('/api/orders/')) {
    if (method !== 'GET') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Phương thức không được hỗ trợ.')
    }

    const match = url.pathname.match(/^\/api\/orders\/(\d+)$/)
    if (!match) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Mã đơn không hợp lệ.')
    }

    const orderId = Number(match[1])
    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Mã đơn không hợp lệ.')
    }

    rejectUnknownQuery(url.searchParams, new Set())
    return { upstreamPath: `/orders/${orderId}` }
  }

  return null
}

async function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  const contentType = request.headers['content-type'] || ''

  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Content-Type phải là application/json.')
  }

  const chunks = []
  let size = 0

  for await (const chunk of request) {
    size += chunk.length

    if (size > maxBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Dữ liệu gửi lên quá lớn.')
    }

    chunks.push(chunk)
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'VALIDATION_ERROR', 'JSON không hợp lệ.')
  }
}

function validateCreateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Dữ liệu tạo đơn không hợp lệ.')
  }

  const keys = Object.keys(body)

  if (keys.some((key) => !['product_id', 'quantity'].includes(key))) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Dữ liệu tạo đơn chứa trường không được hỗ trợ.')
  }

  if (!Number.isSafeInteger(body.product_id) || body.product_id < 1) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'product_id không hợp lệ.')
  }

  if (!Number.isSafeInteger(body.quantity) || body.quantity < 1 || body.quantity > 20) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'quantity phải từ 1 đến 20.')
  }

  return {
    product_id: body.product_id,
    quantity: body.quantity,
  }
}

async function proxyToSmscode(request, response, route, config) {
  const headers = {
    Authorization: `Bearer ${config.token}`,
  }

  const options = {
    method: request.method,
    headers,
  }

  if (route.hasBody) {
    const idempotencyKey = request.headers['idempotency-key']

    if (!idempotencyKey || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotencyKey)) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Idempotency-Key không hợp lệ.')
    }

    const body = validateCreateBody(await readJsonBody(request))

    headers['Content-Type'] = 'application/json'
    headers['Idempotency-Key'] = idempotencyKey
    options.body = JSON.stringify(body)
  }

  const controller = new AbortController()
  options.signal = controller.signal

  const timeout = setTimeout(() => controller.abort(), 30000)
  let upstream

  try {
    upstream = await config.fetchImpl(
      `${config.upstreamBaseUrl}${route.upstreamPath}`,
      options
    )
  } catch {
    throw new HttpError(502, 'UPSTREAM_ERROR', 'Không thể kết nối đến SMSCode.')
  } finally {
    clearTimeout(timeout)
  }

  const contentType = upstream.headers.get('content-type') || ''

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(502, 'UPSTREAM_ERROR', 'SMSCode trả về dữ liệu không hợp lệ.')
  }

  let payload

  try {
    payload = await upstream.json()
  } catch {
    throw new HttpError(502, 'UPSTREAM_ERROR', 'SMSCode trả về JSON không hợp lệ.')
  }

  sendJson(response, upstream.status, payload)
}

function grizzlyErrorMessage(value) {
  const raw = String(value || '').trim()
  const messages = {
    BAD_KEY: 'GrizzlySMS API key không hợp lệ. Kiểm tra GRIZZLY_API_KEY trên Render.',
    NO_BALANCE: 'Số dư GrizzlySMS không đủ.',
    NO_NUMBERS: 'Không có số USA virtual ở mức giá đã chọn. Thử mức giá khác.',
    SERVICE_UNAVAILABLE_REGION: 'GrizzlySMS đang giới hạn truy cập từ khu vực máy chủ này.',
    BAD_SERVICE: 'Mã dịch vụ TikTok không hợp lệ hoặc không được hỗ trợ.',
    BAD_ACTION: 'GrizzlySMS không hỗ trợ thao tác API này.',
  }
  return messages[raw] || raw || 'GrizzlySMS trả về lỗi không xác định.'
}

async function grizzlyRequest(params, config) {
  if (!config.grizzlyApiKey) throw new HttpError(503, 'GRIZZLY_NOT_CONFIGURED', 'Chưa cấu hình GRIZZLY_API_KEY trên Render.')
  const url = new URL(GRIZZLY_BASE_URL)
  url.searchParams.set('api_key', config.grizzlyApiKey)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 25000)
  let response
  try {
    response = await config.fetchImpl(url, { method: 'GET', headers: { accept: 'application/json,text/plain' }, signal: controller.signal })
  } catch {
    throw new HttpError(502, 'GRIZZLY_CONNECTION_ERROR', 'Không thể kết nối GrizzlySMS.')
  } finally { clearTimeout(timeout) }
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = text.trim() }
  if (!response.ok) throw new HttpError(502, 'GRIZZLY_HTTP_ERROR', `GrizzlySMS HTTP ${response.status}: ${String(data).slice(0,180)}`)
  if (typeof data === 'string' && /^(BAD_KEY|NO_BALANCE|NO_NUMBERS|SERVICE_UNAVAILABLE_REGION|BAD_SERVICE|BAD_ACTION|ERROR)/.test(data)) {
    throw new HttpError(502, 'GRIZZLY_API_ERROR', grizzlyErrorMessage(data))
  }
  if (data && typeof data === 'object' && (data.status === 'error' || data.status === 'ERROR')) {
    throw new HttpError(502, 'GRIZZLY_API_ERROR', grizzlyErrorMessage(data.error || data.message))
  }
  return data
}

async function findGrizzlyTikTokService(config) {
  const payload = await grizzlyRequest({ action: 'getServicesList' }, config)
  const services = Array.isArray(payload) ? payload : (payload?.services || payload?.data || [])
  const found = services.find(item => /tiktok/i.test(String(item?.name || item?.title || '')))
  if (!found?.code) throw new HttpError(502, 'GRIZZLY_SERVICE_NOT_FOUND', 'Không tìm thấy service TikTok trong danh sách GrizzlySMS.')
  return String(found.code)
}

function normalizeGrizzlyOrder(data = {}) {
  const smsList = Array.isArray(data.sms) ? data.sms : (data.sms && typeof data.sms === 'object' ? [data.sms] : [])
  const latestSms = smsList.find(item => item?.code || item?.text) || smsList[0] || {}
  const code = String(latestSms.code || data.smsCode || data.code || '').trim()
  const raw = String(data.status || data.activationStatus || '').toUpperCase()
  let status = code ? 'OTP_RECEIVED' : 'ACTIVE'
  if (['CANCELED', 'CANCELLED', 'STATUS_CANCEL'].includes(raw)) status = 'CANCELED'
  else if (['EXPIRED', 'TIMEOUT'].includes(raw)) status = 'EXPIRED'
  else if (['COMPLETED', 'DONE', 'STATUS_OK'].includes(raw)) status = code ? 'OTP_RECEIVED' : 'COMPLETED'
  return {
    id: String(data.activationId || data.id || ''),
    phone_number: String(data.phoneNumber || data.phone_number || data.phone || ''),
    otp_code: code || null,
    status,
    price: data.activationCost ?? data.price ?? null,
    message: latestSms.text || '',
    expired_at: data.activationEnd || null,
    remaining_seconds: null,
  }
}

async function handleGrizzly(request, response, url, config) {
  const pathname = url.pathname
  if (pathname === '/api/grizzly/balance' && request.method === 'GET') {
    rejectUnknownQuery(url.searchParams, new Set())
    const data = await grizzlyRequest({ action: 'getBalance' }, config)
    const value = typeof data === 'string' ? data.replace(/^ACCESS_BALANCE:/, '') : (data?.balance ?? data?.amount ?? data)
    return sendJson(response, 200, { success: true, data: { balance: value } })
  }
  if (pathname === '/api/grizzly/catalog' && request.method === 'GET') {
    rejectUnknownQuery(url.searchParams, new Set())
    const service = await findGrizzlyTikTokService(config)
    return sendJson(response, 200, { success: true, data: { service, country: 12, countryName: 'USA (virtual)', prices: [0.015, 0.025] } })
  }
  if (pathname === '/api/grizzly/orders/create' && request.method === 'POST') {
    rejectUnknownQuery(url.searchParams, new Set())
    const body = await readJsonBody(request)
    if (!body || typeof body !== 'object' || Array.isArray(body) || ![0.015, 0.025].includes(Number(body.maxPrice))) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'maxPrice chỉ được là 0.015 hoặc 0.025.')
    }
    const service = await findGrizzlyTikTokService(config)
    const data = await grizzlyRequest({ action: 'getNumberV2', service, country: 12, maxPrice: Number(body.maxPrice) }, config)
    if (!data || typeof data !== 'object' || !(data.activationId || data.id) || !(data.phoneNumber || data.phone_number)) {
      throw new HttpError(502, 'GRIZZLY_INVALID_ORDER', 'GrizzlySMS không trả về activationId hoặc phoneNumber hợp lệ.')
    }
    const order = normalizeGrizzlyOrder(data)
    order.country_calling_code = '1'
    return sendJson(response, 200, { success: true, data: { orders: [order], failed_count: 0 } })
  }
  const match = pathname.match(/^\/api\/grizzly\/orders\/(\d+)$/)
  if (match && request.method === 'GET') {
    rejectUnknownQuery(url.searchParams, new Set())
    const data = await grizzlyRequest({ action: 'getStatusV2', id: match[1] }, config)
    const order = normalizeGrizzlyOrder({ ...(data && typeof data === 'object' ? data : {}), activationId: match[1] })
    return sendJson(response, 200, { success: true, data: order })
  }
  return null
}

function createApp({
  upstreamBaseUrl = DEFAULT_UPSTREAM,
  token = SMSCODE_TOKEN,
  grizzlyApiKey = GRIZZLY_API_KEY,
  fetchImpl = fetch,
  rootDir = __dirname,
} = {}) {
  const config = {
    upstreamBaseUrl,
    token,
    grizzlyApiKey,
    fetchImpl,
    rootDir,
  }

  return async function app(request, response) {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')

      if (url.pathname.startsWith('/api/grizzly/')) {
        const handled = await handleGrizzly(request, response, url, config)
        if (handled !== null) return handled
        return sendJson(response, 404, errorPayload('NOT_FOUND', 'GrizzlySMS API route không tồn tại.'))
      }

      if (url.pathname.startsWith('/api/')) {
        const route = matchApiRoute(request.method, url)

        if (!route) {
          return sendJson(
            response,
            404,
            errorPayload('NOT_FOUND', 'API route không tồn tại.')
          )
        }

        return await proxyToSmscode(request, response, route, config)
      }

      if (!['GET', 'HEAD'].includes(request.method)) {
        return sendJson(
          response,
          405,
          errorPayload('METHOD_NOT_ALLOWED', 'Phương thức không được hỗ trợ.')
        )
      }

      const file = STATIC_FILES.get(url.pathname)

      if (!file) {
        return sendJson(
          response,
          404,
          errorPayload('NOT_FOUND', 'Không tìm thấy tài nguyên.')
        )
      }

      const contents = await fs.readFile(path.join(rootDir, file[0]))

      response.writeHead(200, {
        'content-type': file[1],
        'content-length': contents.length,
        'x-content-type-options': 'nosniff',
      })

      response.end(request.method === 'HEAD' ? undefined : contents)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR'
      const message = error instanceof HttpError
        ? error.message
        : 'Lỗi máy chủ nội bộ.'

      if (!response.headersSent) {
        sendJson(response, status, errorPayload(code, message))
      } else {
        response.destroy()
      }
    }
  }
}

function openUrl(url) {
  if (process.env.NO_OPEN === '1') return

  const { exec } = require('node:child_process')
  const { platform } = require('node:os')

  let command

  if (platform() === 'win32') {
    command = `start "" "${url}"`
    exec(`cmd.exe /c ${command}`)
  } else if (platform() === 'darwin') {
    exec('open "$URL"', {
      env: { ...process.env, URL: url },
    })
  } else {
    exec('xdg-open "$URL"', {
      env: { ...process.env, URL: url },
    })
  }
}

function configuredPort() {
  if (process.env.PORT === undefined || process.env.PORT === '') {
    return 3000
  }

  const port = Number(process.env.PORT)

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT phải là số nguyên từ 0 đến 65535.')
  }

  return port
}

function startServer({
  port = configuredPort(),
  openBrowser = process.env.NO_OPEN !== '1',
} = {}) {
  return new Promise((resolve, reject) => {
    const app = express()
    app.use(createApp())

    const server = http.createServer(app)
    const io = new Server(server)

    const roomDevices = new Map()
    const roomSettings = new Map()
    const roomRevisions = new Map()

    const publishDevices = (roomId) => {
      const devices = [
        ...(roomDevices.get(roomId)?.entries() || []),
      ].map(([socketId, deviceId]) => ({
        deviceId,
        socketId,
        online: true,
      }))

      io.to(roomId).emit('room-devices', devices)
      console.log(`Tổng thiết bị đang kết nối: ${devices.length}`)
    }

    const sanitizeSettings = (input = {}) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return null
      }

      const provider = ['smscode', 'grizzly'].includes(input.provider)
        ? input.provider
        : null

      if (!provider) return null

      const integerOrNull = (value) => {
        const number = Number(value)
        return Number.isSafeInteger(number) && number > 0 ? number : null
      }

      const countryId = integerOrNull(input.countryId)
      const productId = integerOrNull(input.productId)

      const intervalValue = Number(input.interval)
      const interval = Number.isFinite(intervalValue)
        ? Math.max(1, Math.min(60, Math.round(intervalValue)))
        : 5

      const callingCode = String(input.callingCode || '')
        .replace(/[^0-9]/g, '')
        .slice(0, 5)

      const countryName = String(input.countryName || '')
        .replace(/[<>]/g, '')
        .slice(0, 80)

      return {
        provider,
        countryId,
        countryName,
        callingCode,
        productId,
        interval,
      }
    }

    io.on('connection', (socket) => {

      // Thiết bị tham gia phòng
      socket.on('join-room', ({ roomId, deviceId } = {}) => {
        if (
          roomId !== 'room-main' ||
          typeof deviceId !== 'string' ||
          !/^[\w-]{8,80}$/.test(deviceId)
        ) {
          return
        }

        if (socket.data.roomId) {
          socket.leave(socket.data.roomId)
          roomDevices.get(socket.data.roomId)?.delete(socket.id)
          publishDevices(socket.data.roomId)
        }

        socket.join(roomId)

        socket.data.roomId = roomId
        socket.data.deviceId = deviceId

        if (!roomDevices.has(roomId)) {
          roomDevices.set(roomId, new Map())
        }

        roomDevices.get(roomId).set(socket.id, deviceId)

        // Gửi cấu hình mới nhất cho thiết bị vừa kết nối
        const savedSettings = roomSettings.get(roomId) || null

        socket.emit('room-settings', {
          settings: savedSettings,
          revision: roomRevisions.get(roomId) || 0,
          senderDeviceId: null,
        })

        publishDevices(roomId)
      })

      // Đồng bộ cấu hình hai chiều
      socket.on('room-settings', (payload = {}) => {
        if (
          socket.data.roomId !== payload.roomId ||
          socket.data.deviceId !== payload.senderDeviceId
        ) {
          return
        }

        const settings = sanitizeSettings(payload.settings)
        if (!settings) return

        const revision = (roomRevisions.get(payload.roomId) || 0) + 1

        roomSettings.set(payload.roomId, settings)
        roomRevisions.set(payload.roomId, revision)

        socket.to(payload.roomId).emit('room-settings', {
          settings,
          revision,
          senderDeviceId: socket.data.deviceId,
        })
      })

      // Điều khiển các thiết bị trong phòng
      socket.on('room-command', (command = {}) => {
        if (
          socket.data.roomId !== command.roomId ||
          socket.data.deviceId !== command.senderDeviceId
        ) {
          return
        }

        if (
          !/^[\w-]{8,80}$/.test(command.commandId || '') ||
          !['GET_PHONE', 'BUY_ALL', 'CLEAR_ALL'].includes(command.type)
        ) {
          return
        }

        const event = {
          roomId: command.roomId,
          commandId: command.commandId,
          type: command.type,
          senderDeviceId: command.senderDeviceId,
          timestamp: Date.now(),
        }

        io.to(command.roomId).emit('room-command', event)
      })

      // Khi thiết bị ngắt kết nối
      socket.on('disconnect', () => {
        const roomId = socket.data.roomId

        if (!roomId) return

        roomDevices.get(roomId)?.delete(socket.id)
        publishDevices(roomId)
      })
    })

    server.once('error', reject)

    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject)

      const address = server.address()
      const url = `http://127.0.0.1:${address.port}`

      console.log(`Listening on ${url}`)

      for (const interfaces of Object.values(os.networkInterfaces())) {
        for (const address of interfaces || []) {
          if (address.family === 'IPv4' && !address.internal) {
            console.log(
              `Phone/LAN: http://${address.address}:${server.address().port}`
            )
          }
        }
      }

      if (openBrowser) openUrl(url)

      resolve(server)
    })
  })
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(`Không thể khởi động server: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  createApp,
  startServer,
}
