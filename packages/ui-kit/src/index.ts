export const UI_KIT_VERSION = 'ui-kit-v1'

export const renderBadge = (label: string): string => {
  return `<span class="badge">${label} · ${UI_KIT_VERSION}</span>`
}
