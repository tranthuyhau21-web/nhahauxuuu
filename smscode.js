(function (root, factory) {
  const api = factory()

  if (typeof module === 'object' && module.exports) {
    module.exports = api
  }

  root.SmscodeApi = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const BASE_URL = '/api'

  function createSmscodeClient({ fetchImpl = fetch } = {}) {
    async function request(path, options = {}) {
      const response = await fetchImpl(`${BASE_URL}${path}`, {
        ...options,
        headers: {
          ...options.headers,
        },
      })

      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`API trả về dữ liệu không hợp lệ (HTTP ${response.status}).`)
      }

      if (!response.ok || !payload.success) {
        const message = payload.error?.message || `Yêu cầu thất bại (HTTP ${response.status}).`
        const error = new Error(message)
        error.code = payload.error?.code
        error.status = response.status
        throw error
      }

      return payload.data
    }

    return {
      getCountries() {
        return request('/catalog/countries')
      },

      getServices(countryId) {
        const query = new URLSearchParams({ country_id: String(countryId) })
        return request(`/catalog/services?${query}`)
      },

      getProducts(countryId, platformId) {
        const query = new URLSearchParams({
          country_id: String(countryId),
          platform_id: String(platformId),
          sort: 'price_asc',
          limit: '10000',
          page: '1',
        })
        return request(`/catalog/products?${query}`)
      },

      createOrder({ productId, quantity, idempotencyKey }) {
        return request('/orders/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ product_id: Number(productId), quantity: Number(quantity) }),
        })
      },

      getOrder(orderId) {
        return request(`/orders/${encodeURIComponent(orderId)}`)
      },
    }
  }

  return { createSmscodeClient }
})
