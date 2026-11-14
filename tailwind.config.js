/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        app: {
          DEFAULT: '#09090b', // zinc-950
          surface: '#111114',
        },
        card: {
          DEFAULT: '#18181b', // zinc-900
          hover: '#1f1f23',
          elevated: '#27272a', // zinc-800
        },
        subtle: {
          border: '#27272a', // zinc-800
          hover: '#3f3f46', // zinc-700
        },
        text: {
          main: '#fafafa', // zinc-50
          muted: '#a1a1aa', // zinc-400
          dim: '#71717a', // zinc-500
        },
        silence: {
          DEFAULT: 'rgba(239, 68, 68, 0.15)',
          border: '#ef4444',
          badge: '#ef4444',
        },
      },
      borderRadius: {
        'outer-box': '8px',
        'inner-btn': '4px',
        'outer-card': '12px',
        'inner-card': '8px',
      },
      fontSize: {
        '2xs': ['10px', '14px'],
        'xs': ['12px', '16px'],
        'sm': ['13px', '18px'],
        'base': ['14px', '20px'],
      },
    },
  },
  plugins: [],
}
