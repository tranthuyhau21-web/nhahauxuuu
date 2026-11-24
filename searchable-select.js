(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  root.SearchableSelect = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalize(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('vi')
      .trim()
  }

  function createChoiceStore(items, { resultLimit = 50 } = {}) {
    const labelCounts = new Map()
    for (const item of items) labelCounts.set(item.label, (labelCounts.get(item.label) || 0) + 1)

    const choices = items.map((item) => ({
      ...item,
      displayLabel: labelCounts.get(item.label) > 1 ? `${item.label} — ID ${item.id}` : item.label,
    }))
    const byDisplayLabel = new Map(choices.map((item) => [item.displayLabel, item]))

    return {
      all() {
        return choices.slice()
      },
      search(query) {
        const needle = normalize(query)
        return choices.filter((item) => normalize(item.displayLabel).includes(needle)).slice(0, resultLimit)
      },
      resolve(displayLabel) {
        return byDisplayLabel.get(displayLabel) || null
      },
    }
  }

  function moveActiveIndex(currentIndex, direction, length) {
    if (length < 1) return -1
    return (currentIndex + direction + length) % length
  }

  return { createChoiceStore, moveActiveIndex }
})
