try {
  var stored = localStorage.getItem('theme')
  var dark = stored === 'dark' || ((!stored || stored === 'system') && matchMedia('(prefers-color-scheme: dark)').matches)

  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
} catch {}
