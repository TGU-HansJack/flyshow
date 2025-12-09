(() => {
  const key = 'flyshow-theme'
  const saved = localStorage.getItem(key)
  if (saved) document.body.setAttribute('data-theme', saved)
  const btn = document.getElementById('toggle-theme')
  if (btn) {
    btn.addEventListener('click', () => {
      const next =
        document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
      document.body.setAttribute('data-theme', next)
      localStorage.setItem(key, next)
    })
  }
})()
