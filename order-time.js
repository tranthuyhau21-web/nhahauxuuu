(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  root.OrderTime = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function formatPurchaseTime(order, now = new Date(), formatter = (date) => date.toLocaleString('vi-VN')) {
    const apiDate = order?.created_at ? new Date(order.created_at) : null
    const purchaseDate = apiDate && !Number.isNaN(apiDate.getTime()) ? apiDate : now
    return formatter(purchaseDate)
  }

  return { formatPurchaseTime }
})
