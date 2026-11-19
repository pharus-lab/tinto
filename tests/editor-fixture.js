import { WritingEditor } from '../src/editor'
import { renderAlternatives } from '../src/alternatives'
import { newBlock } from '../src/model'
import { loadSpelling, spellingPlugin } from '../src/spelling'

const saved = await window.readManuscript()
const doc = saved ?? { type: 'doc', content: [newBlock('I want to eat a cat.')] }
const dictionary = await loadSpelling('en')
const status = document.querySelector('output')
let groupId = null
const editor = new WritingEditor(document.querySelector('main'), doc, {
  plugins: [spellingPlugin(dictionary)],
  selection() { if (groupId) showGroup(groupId) },
  message(message) { status.textContent = message }
})

function showGroup(id) {
  groupId = id ?? null
  editor.review(groupId)
  renderAlternatives(document.querySelector('#choices'), editor, groupId, showGroup)
}

document.querySelector('nav').onmousedown = event => event.preventDefault()
document.querySelector('#add').onclick = () => {
  const id = editor.addAlternative()
  if (id) showGroup(id)
}
document.querySelector('#review').onclick = () => showGroup(editor.context()?.id)
document.querySelector('#save').onclick = async () => {
  await window.writeManuscript(editor.json())
  status.textContent = 'Saved'
}
document.body.dataset.ready = 'yes'
