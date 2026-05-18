import { useState, useEffect, useRef } from 'react'
import { useEscape } from './Toast'

/**
 * Modal usato per conferme e input.
 * Sostituisce window.prompt/confirm con un'esperienza coerente al brand.
 */
export function Modal({ open, title, children, onClose, maxWidth = '480px' }) {
  useEscape(onClose, open)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[8000] flex items-center justify-center bg-black/70 backdrop-blur-sm
                    animate-[fadeIn_0.15s_ease-out]"
         onClick={onClose}>
      <div className="bg-bg-panel border-2 border-bg-border rounded-xl shadow-2xl
                      animate-[scaleIn_0.18s_ease-out]"
           style={{ maxWidth, width: '100%' }}
           onClick={e => e.stopPropagation()}>
        {title && (
          <div className="px-5 py-3 border-b border-bg-border">
            <h3 className="font-mono text-base font-semibold text-gold">{title}</h3>
          </div>
        )}
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

/**
 * Modal con conferma stile retail.
 * @returns {Promise<boolean>}
 */
export function useConfirm() {
  const [state, setState] = useState({ open: false, resolve: null, opts: {} })

  const confirm = (opts = {}) => new Promise(resolve => {
    setState({ open: true, resolve, opts })
  })

  const onResolve = (val) => {
    state.resolve?.(val)
    setState(s => ({ ...s, open: false }))
  }

  const ConfirmDialog = () => state.open ? (
    <Modal open title={state.opts.title || 'Conferma'} onClose={() => onResolve(false)}>
      <p className="font-sans text-sm text-text-primary mb-4 leading-relaxed">
        {state.opts.message}
      </p>
      <div className="flex justify-end gap-2">
        <button onClick={() => onResolve(false)}
                className="px-4 py-2 rounded-md font-mono text-sm text-text-secondary hover:text-text-primary border border-bg-border hover:bg-bg-hover">
          {state.opts.cancelText || 'Annulla'}
        </button>
        <button onClick={() => onResolve(true)}
                className={`px-4 py-2 rounded-md font-mono text-sm font-medium border transition-all ${
                  state.opts.danger
                    ? 'bg-red/20 text-red border-red/50 hover:bg-red/30'
                    : 'bg-gold/20 text-gold border-gold/50 hover:bg-gold/30'
                }`}>
          {state.opts.confirmText || 'Conferma'}
        </button>
      </div>
    </Modal>
  ) : null

  return { confirm, ConfirmDialog }
}

/**
 * Modal con input numerico per chiusura decisione.
 */
export function usePromptNumber() {
  const [state, setState] = useState({ open: false, resolve: null, opts: {} })
  const [value, setValue] = useState('')
  const [notes, setNotes] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (state.open && inputRef.current) {
      setTimeout(() => inputRef.current?.select(), 50)
    }
  }, [state.open])

  const promptNumber = (opts = {}) => new Promise(resolve => {
    setValue(opts.defaultValue != null ? String(opts.defaultValue) : '')
    setNotes('')
    setState({ open: true, resolve, opts })
  })

  const onResolve = (val) => {
    state.resolve?.(val)
    setState(s => ({ ...s, open: false }))
  }

  const handleSubmit = () => {
    const num = parseFloat(value)
    if (isNaN(num)) return
    onResolve({ value: num, notes })
  }

  const PromptDialog = () => state.open ? (
    <Modal open title={state.opts.title || 'Inserisci valore'} onClose={() => onResolve(null)}>
      {state.opts.message && (
        <p className="font-sans text-sm text-text-primary mb-3">{state.opts.message}</p>
      )}
      {state.opts.subtext && (
        <p className="font-mono text-xs text-text-muted mb-3">{state.opts.subtext}</p>
      )}

      <label className="block font-mono text-xs text-text-secondary mb-1">
        {state.opts.label || 'Valore'}
      </label>
      <input
        ref={inputRef}
        type="number"
        step="any"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
        className="w-full bg-bg-primary border border-bg-border rounded-md px-3 py-2
                   font-mono text-sm text-text-primary outline-none focus:border-gold/50"
      />

      {state.opts.allowNotes && (
        <>
          <label className="block font-mono text-xs text-text-secondary mb-1 mt-3">
            Note (opzionale)
          </label>
          <input
            type="text"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
            placeholder="es: chiusura manuale prima di NFP"
            className="w-full bg-bg-primary border border-bg-border rounded-md px-3 py-2
                       font-mono text-sm text-text-primary placeholder-text-muted outline-none focus:border-gold/50"
          />
        </>
      )}

      <div className="flex justify-end gap-2 mt-4">
        <button onClick={() => onResolve(null)}
                className="px-4 py-2 rounded-md font-mono text-sm text-text-secondary hover:text-text-primary border border-bg-border hover:bg-bg-hover">
          Annulla
        </button>
        <button onClick={handleSubmit}
                className="px-4 py-2 rounded-md font-mono text-sm font-medium bg-gold/20 text-gold border border-gold/50 hover:bg-gold/30">
          {state.opts.confirmText || 'Conferma'}
        </button>
      </div>
    </Modal>
  ) : null

  return { promptNumber, PromptDialog }
}
