import { WritingEditor, schema } from '../src/editor'
import { writingPlugin, checkWriting, configureWriting, writingIssues, writingStatus, applyWriting, ignoreWriting, dismissWriting } from '../src/writing-checks'
import { writingProse } from '../src/writing-prose'
import { trackWriting } from '../src/writing-evidence'
import { renderWritingChecks } from '../src/writing-ui'
import { writingSettings } from '../src/writing-settings'
import { observeWritingPreferences } from '../src/writing-preferences'
import { WRITING_LANGUAGES } from '../src/writing-types'

let editor, tracker, unobserve
const samples = [], requests = []
const render = () => renderWritingChecks(document.querySelector('aside'), editor.view, message => { document.querySelector('output').textContent = message })
window.proof = {
  setup(doc, preferences = { spelling: false, grammar: false, words: {}, disabledRules: [] }) {
    tracker?.stop(); editor?.destroy(); unobserve?.(); samples.length = requests.length = 0
    localStorage.setItem('writing-checks', JSON.stringify(preferences))
    editor = new WritingEditor(document.querySelector('main'), doc, {
      plugins: [writingPlugin({ language: 'en', preferences, check: request => { requests.push(request); return window.checkWriting(request) }, changed: render })]
    })
    unobserve = observeWritingPreferences(preferences => configureWriting(editor.view, { preferences }))
    tracker = trackWriting(editor.view, { path: '', projectId: '', documentId: '' }, (...args) => { samples.push(args); return null })
    render()
  },
  render,
  settings: () => { const host = document.querySelector('#settings'); host.replaceChildren(); writingSettings(host, WRITING_LANGUAGES) },
  requests, samples,
  check: () => checkWriting(editor.view),
  configure: config => configureWriting(editor.view, config),
  status: () => writingStatus(editor.view.state),
  issues: () => writingIssues(editor.view.state).map(({ diagnostic, manualReason }) => ({ ...diagnostic, manualReason })),
  apply(source, text) {
    const issue = writingIssues(editor.view.state).find(item => item.diagnostic.source === source)
    return issue && applyWriting(editor.view, issue, issue.diagnostic.replacements.findIndex(item => item.text === text))
  },
  remember: () => { window.oldIssue = writingIssues(editor.view.state)[0] },
  applyOld: () => applyWriting(editor.view, window.oldIssue, 0),
  ignore: () => ignoreWriting(editor.view, writingIssues(editor.view.state)[0]),
  dismiss: () => dismissWriting(editor.view),
  json: () => editor.json(),
  raw: () => editor.view.state.doc.toJSON(),
  text: () => editor.view.state.doc.textContent,
  prose: () => editor.view.state.doc.children.map(node => writingProse(node, editor.markdown).text),
  markdown: enabled => editor.setMarkdown(enabled),
  source(text) {
    editor.setMarkdown(true)
    editor.view.dispatch(editor.view.state.tr.replaceWith(0, editor.view.state.doc.content.size, schema.nodes.paragraph.create({ id: 'source' }, schema.text(text))))
  },
  section: id => editor.showSection(id),
  edit: (from, to, text) => editor.view.dispatch(editor.view.state.tr.insertText(text, from, to)),
  append: text => editor.view.dispatch(editor.view.state.tr.insert(editor.view.state.doc.content.size, schema.nodes.paragraph.create({ id: 'appended' }, schema.text(text)))),
  undo: () => editor.undo(), redo: () => editor.redo(),
  flush: () => tracker.flush()
}
