import { ThemeProvider } from 'next-themes'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { TooltipProvider } from '@/components/ui/tooltip'

import { App } from './app'
import { DataProvider } from './data'

import '../index.css'
import './theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <TooltipProvider>
        <DataProvider>
          <App />
        </DataProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
