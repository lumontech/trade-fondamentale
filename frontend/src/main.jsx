import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AuthGuard from './components/AuthGuard'
import { ToastProvider } from './components/ui/Toast'

createRoot(document.getElementById('root')).render(
  <ToastProvider>
    <AuthGuard>
      <App />
    </AuthGuard>
  </ToastProvider>
)
