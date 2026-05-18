import { useState } from 'react'
import ScoringPanel  from './ScoringPanel'
import TechnicalPanel from './TechnicalPanel'
import SetupPanel    from './SetupPanel'

const PANELS = [
  { id: 'all',     label: 'Tutti',      icon: '⊟', desc: 'Tutti e tre i pannelli affiancati' },
  { id: 'scoring', label: 'Decisione',  icon: '🎯', desc: 'Solo Decisione operativa', component: ScoringPanel },
  { id: 'tech',    label: 'Tecnica',    icon: '📊', desc: 'Solo Analisi tecnica',     component: TechnicalPanel },
  { id: 'setup',   label: 'Setup',      icon: '⚡', desc: 'Solo Setup operativo',     component: SetupPanel },
]

const STORAGE_KEY = 'itp_analysis_focus_mode'

export default function AnalysisRow() {
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || 'all' } catch { return 'all' }
  })

  const setModeStored = (m) => {
    setMode(m)
    try { localStorage.setItem(STORAGE_KEY, m) } catch {}
  }

  const FocusedComponent = mode === 'all' ? null : PANELS.find(p => p.id === mode)?.component

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Toggle bar compatto */}
      <div className="flex items-center gap-1 px-2 py-1 bg-bg-secondary/40 border-b border-bg-border/50 shrink-0">
        <span className="font-mono text-xxs text-text-muted uppercase tracking-widest mr-2 hidden md:inline">Vista:</span>
        {PANELS.map(p => (
          <button key={p.id}
                  onClick={() => setModeStored(p.id)}
                  title={p.desc}
                  className={`px-2.5 py-0.5 rounded font-mono text-xxs transition-all flex items-center gap-1 ${
                    mode === p.id
                      ? 'bg-gold/20 text-gold border border-gold/40'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover border border-transparent'
                  }`}>
            <span className="text-sm leading-none">{p.icon}</span>
            <span className="hidden sm:inline">{p.label}</span>
          </button>
        ))}
      </div>

      {/* Contenuto */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {mode === 'all' ? (
          <div className="flex h-full overflow-hidden">
            <div className="flex-1 panel border-r border-bg-border overflow-hidden min-w-0">
              <ScoringPanel />
            </div>
            <div className="flex-1 panel border-r border-bg-border overflow-hidden min-w-0">
              <TechnicalPanel />
            </div>
            <div className="flex-1 panel overflow-hidden min-w-0">
              <SetupPanel />
            </div>
          </div>
        ) : (
          <div className="panel h-full overflow-hidden">
            {FocusedComponent && <FocusedComponent />}
          </div>
        )}
      </div>
    </div>
  )
}
