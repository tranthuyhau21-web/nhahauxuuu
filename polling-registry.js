(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  root.PollingRegistry = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createPollingRegistry({ clearTimer = clearTimeout } = {}) {
    const timers = new Map()

    return {
      set(orderId, timer) {
        if (timers.has(orderId)) clearTimer(timers.get(orderId))
        timers.set(orderId, timer)
      },
      stop(orderId) {
        if (!timers.has(orderId)) return false
        clearTimer(timers.get(orderId))
        timers.delete(orderId)
        return true
      },
      stopAll() {
        for (const timer of timers.values()) clearTimer(timer)
        timers.clear()
      },
      has(orderId) {
        return timers.has(orderId)
      },
      size() {
        return timers.size
      },
    }
  }

  return { createPollingRegistry }
})
