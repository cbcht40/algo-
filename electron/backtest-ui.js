async function refresh() {
  const state = await window.electronBacktest.info()
  document.getElementById('status').textContent = state?.ready ? '● Prêt à se connecter' : state?.error || 'Le moteur local démarre…'
  document.getElementById('renew').textContent = state?.error ? 'Relancer le moteur' : 'Renouveler le code'
  document.getElementById('code').textContent = state?.code ? `${state.code.slice(0, 3)} ${state.code.slice(3)}` : '··· ···'
}
window.electronBacktest.onChange(refresh)
document.getElementById('site').onclick = () => window.electronBacktest.openSite()
document.getElementById('renew').onclick = () => window.electronBacktest.newCode()
refresh()
