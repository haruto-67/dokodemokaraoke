import { el } from '../lib/dom'

/**
 * window.prompt()の代替モーダル。
 * ElectronのBrowserWindowはalert()/confirm()はネイティブ実装されているが、
 * prompt()は未サポートで呼ぶと例外になるため、自前のテキスト入力ダイアログで代替する。
 */
export function showPromptDialog(title: string, defaultValue = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = el('div', { className: 'prompt-dialog-overlay visible' })
    const dialog = el('div', { className: 'prompt-dialog panel' })
    const heading = el('div', { className: 'prompt-dialog-title' }, [title])
    const input = el('input', {
      type: 'text',
      className: 'prompt-dialog-input',
      value: defaultValue
    }) as HTMLInputElement

    const cancelBtn = el('button', { className: 'btn btn-ghost' }, ['キャンセル'])
    const okBtn = el('button', { className: 'btn btn-primary' }, ['OK'])
    const actions = el('div', { className: 'prompt-dialog-actions' }, [cancelBtn, okBtn])

    dialog.append(heading, input, actions)
    overlay.appendChild(dialog)
    document.body.appendChild(overlay)

    const close = (result: string | null): void => {
      document.removeEventListener('keydown', onKeydown)
      overlay.remove()
      resolve(result)
    }
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(null)
      if (e.key === 'Enter') close(input.value)
    }

    cancelBtn.addEventListener('click', () => close(null))
    okBtn.addEventListener('click', () => close(input.value))
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null)
    })
    document.addEventListener('keydown', onKeydown)

    input.focus()
    input.select()
  })
}
