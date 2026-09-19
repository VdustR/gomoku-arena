import { mount } from 'svelte'
import './styles/app.css'
import App from './App.svelte'

const target = document.getElementById('app')
if (!target) throw new Error('The page is missing its #app element.')

export default mount(App, { target })
