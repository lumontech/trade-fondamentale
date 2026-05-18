import { createContext, useContext, useState, useCallback, useEffect } from 'react'

const ToastContext = createContext(null)

const TYPE_STYLE = {
  success: { bg: '#00e09618', border: '#00e09660', text: '#00e096', icon: '✓' },
  error:   { bg: '#ff335518', border: '#ff335560', text: '#ff3355', icon: '⚠' },
  warning: { bg: '#f5c84218', border: '#f5c84260', text: '#f5c842', icon: '!' },
  info:    { bg: '#2196F318', border: '#2196F360', text: '#2196F3', icon: 'ℹ' },
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts(t => t.filter(x => x.id !== id))
  }, [])

  const toast = useCallback((message, opts = {}) => {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const type = opts.type || 'info'
    const duration = opts.duration ?? 3500
    setToasts(t => [...t, { id, message, type, title: opts.title }])
    if (duration > 0) {
      setTimeout(() => dismiss(id), duration)
    }
    return id
  }, [dismiss])

  const api = {
    toast,
    success: (msg, opts) => toast(msg, { ...opts, type: 'success' }),
    error:   (msg, opts) => toast(msg, { ...opts, type: 'error' }),
    warning: (msg, opts) => toast(msg, { ...opts, type: 'warning' }),
    info:    (msg, opts) => toast(msg, { ...opts, type: 'info' }),
    dismiss,
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onDismiss }) {
  const style = TYPE_STYLE[toast.type] || TYPE_STYLE.info
  return (
    <div
      className="pointer-events-auto rounded-lg border-2 px-4 py-3 min-w-[280px] max-w-md shadow-2xl
                 animate-[slideInRight_0.3s_ease-out]"
      style={{ backgroundColor: '#0d1117', borderColor: style.border }}
    >
      <div className="flex items-start gap-3">
        <span className="text-lg leading-none" style={{ color: style.text }}>{style.icon}</span>
        <div className="flex-1 min-w-0">
          {toast.title && (
            <div className="font-mono text-xs font-semibold mb-0.5" style={{ color: style.text }}>
              {toast.title}
            </div>
          )}
          <div className="font-sans text-sm text-text-primary leading-snug">{toast.message}</div>
        </div>
        <button onClick={onDismiss}
                className="text-text-muted hover:text-text-primary text-lg leading-none -mt-1">
          ×
        </button>
      </div>
    </div>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}

// Hook globale per ESC key (chiusura modali/pannelli)
export function useEscape(callback, active = true) {
  useEffect(() => {
    if (!active) return
    const onKey = (e) => { if (e.key === 'Escape') callback() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [callback, active])
}
