import { createApp } from 'vue'
import App from './App.vue'
import './styles/main.css'

function markHostChrome() {
  const w = window as Window & { nimiq?: unknown, nimiqPay?: unknown }
  const mini = !!w.nimiq || !!w.nimiqPay
  document.documentElement.classList.toggle('gp-miniapp', mini || document.documentElement.classList.contains('gp-miniapp'))
  const standalone = window.matchMedia('(display-mode: standalone)').matches
  document.documentElement.classList.toggle('gp-standalone', standalone && !mini)
}

markHostChrome()
window.addEventListener('nimiq#initialized', markHostChrome)
setTimeout(markHostChrome, 0)
setTimeout(markHostChrome, 400)

createApp(App).mount('#app')
