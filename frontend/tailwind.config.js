/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#04060a',
          secondary: '#0a0e17',
          panel: '#0d1117',
          hover: '#161b27',
          border: '#1e2535',
        },
        green: { DEFAULT: '#00e096', dim: '#00b377', muted: '#00e09622' },
        red: { DEFAULT: '#ff3355', dim: '#cc2244', muted: '#ff335522' },
        gold: { DEFAULT: '#f5c842', dim: '#c9a22f' },
        blue: { DEFAULT: '#2196F3', accent: '#0088ff' },
        purple: { DEFAULT: '#9C27B0' },
        orange: { DEFAULT: '#FF9800' },
        text: {
          primary: '#e8eaf0',
          secondary: '#8892a4',
          muted: '#4a5568',
        },
      },
      fontFamily: {
        mono: ['IBM Plex Mono', 'Courier New', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      fontSize: {
        xxs: ['0.65rem', { lineHeight: '0.9rem' }],
      },
    },
  },
  plugins: [],
}
