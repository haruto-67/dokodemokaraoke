/** 最小限の DOM 生成ヘルパー */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & {
    className?: string
    html?: string
    style?: Partial<CSSStyleDeclaration>
  } = {},
  children: (Node | string)[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  const { className, html, style, ...rest } = props as Record<string, unknown>
  if (className) node.className = className as string
  if (html !== undefined) node.innerHTML = html as string
  if (style) Object.assign(node.style, style)
  Object.assign(node, rest)
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  const cs = Math.floor((sec - Math.floor(sec)) * 100)
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}
