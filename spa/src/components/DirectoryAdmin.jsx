import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { Icon } from './ui/Icon'
import { SkeletonRows } from './ui/Skeleton'
import { useToast } from './Toaster'
import { useConfirm } from './ConfirmDialog'
import { ActionRow, Group, Row, Section } from './opconfig/OpConfigForms'

/**
 * `/admin` → Directory: the organisation directory (docs 18 §4.7).
 *
 * An administrator uploads the people list their mail system already exports,
 * for one tenant (an email domain). Everyone signed in at that tenant can then
 * find those people by name wherever they type an address — before any of them
 * has signed in, which is the point.
 *
 * Two steps on purpose. **Preview** sends the file and writes nothing; it shows
 * what the import would add, rename and remove, and how many addresses fall
 * under each domain — which is where a typo like `example.com.ay` is caught.
 * **Import** sends the same file again and replaces the directory with it.
 * Replacing is what makes a leaver drop out on the next export, and it is why
 * an import that would remove most of a directory needs an explicit tick.
 *
 * Not configuration: nothing here is versioned or published, so this tab has
 * no Publish bar.
 */

const MAX_BYTES = 4 * 1024 * 1024

const SKIP_REASON = {
  missing_email: 'no address',
  invalid_email: 'not an address',
  too_many: 'over the limit',
}

const ERRORS = {
  public_domain: 'That is a public mailbox domain — a directory there would be visible to strangers.',
  bad_tenant: 'The tenant must be an email domain, like example.com.',
  no_email_column: 'No column in that file holds email addresses',
  empty_file: 'The file is empty.',
  file_too_large: 'The file is too large (4 MB at most).',
  no_entries: 'The file has no usable addresses. To empty a directory, remove it instead.',
  directory_shrink: 'This import would remove most of the directory. Tick the confirmation and import again.',
}

const describe = e => {
  const base = ERRORS[e?.code]
  if (!base) return `Failed (${e?.code || 'error'}).`
  return e.code === 'no_email_column' && e.message ? `${base}: ${e.message}` : base
}

const csvCell = v => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

function download(tenantId, entries) {
  const text = '\uFEFFName,Email\r\n' + entries.map(e => `${csvCell(e.name || '')},${csvCell(e.email)}`).join('\r\n') + '\r\n'
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `directory-${tenantId}.csv`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

function Preview({ p }) {
  const c = p.counts
  return (
    <>
      {p.warnings.includes('tenant_cannot_sign_in') && (
        <Banner kind="warn">
          Sign-in on this deployment is limited to another domain, so nobody at {p.tenantId} can sign in to see this
          directory.
        </Banner>
      )}
      <Row
        title={`${plural(c.entries, 'person', 'people')} in the file`}
        sub={[
          c.duplicates ? `${plural(c.duplicates, 'duplicate')} merged` : '',
          c.skipped ? `${plural(c.skipped, 'row')} skipped` : '',
          p.format === 'addresses' ? 'read as a recipient list' : `columns: ${[...p.columns.email, ...p.columns.name].join(', ')}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      <Row
        title="What importing does"
        sub={
          c.existing
            ? `Adds ${c.added}, renames ${c.updated}, removes ${c.removed}, leaves ${c.unchanged} unchanged (of ${c.existing} now).`
            : `Creates the directory with ${plural(c.added, 'person', 'people')}.`
        }
      />
      <Row title="Addresses by domain" sub="Check for typos — anything not at the tenant is still listed, and findable." stacked>
        <ul className="dir-list">
          {p.domains.map(d => (
            <li key={d.domain}>
              <code>{d.domain}</code> <span className="sr-sub">{d.count}</span>
              {!d.sameAsTenant && <span className="chip chip-sm">not {p.tenantId}</span>}
            </li>
          ))}
        </ul>
      </Row>
      {p.skipped.length > 0 && (
        <Row title="Skipped rows" sub={c.skipped > p.skipped.length ? `First ${p.skipped.length} of ${c.skipped}` : undefined} stacked>
          <ul className="dir-list">
            {p.skipped.map(s => (
              <li key={`${s.line}-${s.text}`}>
                line {s.line}: {SKIP_REASON[s.reason] || s.reason} — <code>{s.text || '(empty)'}</code>
              </li>
            ))}
          </ul>
        </Row>
      )}
      {p.sample.updated.length > 0 && (
        <Row title="Renamed" sub={c.updated > p.sample.updated.length ? `First ${p.sample.updated.length} of ${c.updated}` : undefined} stacked>
          <ul className="dir-list">
            {p.sample.updated.map(u => (
              <li key={u.email}>
                <code>{u.email}</code>: {u.was || '(no name)'} → {u.name || '(no name)'}
              </li>
            ))}
          </ul>
        </Row>
      )}
      {p.sample.removed.length > 0 && (
        <Row title="Removed" sub={c.removed > p.sample.removed.length ? `First ${p.sample.removed.length} of ${c.removed}` : undefined} stacked>
          <ul className="dir-list">
            {p.sample.removed.map(email => (
              <li key={email}>
                <code>{email}</code>
              </li>
            ))}
          </ul>
        </Row>
      )}
    </>
  )
}

export function DirectoryAdmin() {
  const toast = useToast()
  const confirm = useConfirm()
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [tenant, setTenant] = useState('')
  const [file, setFile] = useState(null) // { name, text }
  const [paste, setPaste] = useState('')
  const [pasting, setPasting] = useState(false)
  const [preview, setPreview] = useState(null)
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef(null)

  const load = () => {
    setLoadError('')
    return api
      .adminDirectory()
      .then(d => {
        setData(d)
        setTenant(t => t || d.defaultTenant || '')
      })
      .catch(e => setLoadError(e.code || 'request_failed'))
  }
  useEffect(() => {
    load()
  }, [])

  const source = pasting ? (paste.trim() ? { name: 'pasted list', text: paste } : null) : file
  // Anything that changes what would be imported makes the preview stale.
  const invalidate = () => {
    setPreview(null)
    setForce(false)
    setError('')
  }

  async function pick(e) {
    invalidate()
    const f = e.target.files?.[0]
    if (!f) return setFile(null)
    if (f.size > MAX_BYTES) {
      setFile(null)
      setError(ERRORS.file_too_large)
      return
    }
    setFile({ name: f.name, text: await f.text() })
  }

  async function runPreview() {
    if (!source) return
    setBusy(true)
    setError('')
    try {
      setPreview(await api.adminDirectoryPreview({ tenantId: tenant.trim(), csv: source.text, fileName: source.name }))
      setForce(false)
    } catch (e) {
      setPreview(null)
      setError(describe(e))
    } finally {
      setBusy(false)
    }
  }

  async function runImport() {
    if (!source || !preview) return
    setBusy(true)
    setError('')
    try {
      const r = await api.adminDirectoryImport({ tenantId: preview.tenantId, csv: source.text, fileName: source.name, force })
      toast(`Imported ${plural(r.counts.entries, 'person', 'people')} into ${r.tenantId}. Search picks it up within a minute.`)
      setPreview(null)
      setFile(null)
      setPaste('')
      setForce(false)
      if (fileRef.current) fileRef.current.value = ''
      await load()
    } catch (e) {
      setError(describe(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(tenantId, count) {
    const ok = await confirm({
      title: `Remove the ${tenantId} directory?`,
      body: `${plural(count, 'person', 'people')} stop being suggested to people at ${tenantId}. Anyone who has signed in is still found — this removes the imported list only.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (!ok) return
    try {
      await api.adminDirectoryRemove(tenantId)
      toast(`Removed the ${tenantId} directory.`)
      await load()
    } catch (e) {
      toast(describe(e))
    }
  }

  async function exportCsv(tenantId) {
    try {
      const r = await api.adminDirectoryEntries(tenantId)
      download(tenantId, r.entries)
    } catch (e) {
      toast(describe(e))
    }
  }

  return (
    <Section
      title="Directory"
      hint="The people your organisation has, imported from your mail system's export. Everyone signed in at the tenant can find them by name when inviting — including people who have never signed in."
    >
      <Group title="Directories">
        {loadError && (
          <Banner kind="danger">
            Could not load directories ({loadError}).{' '}
            <a href="#" onClick={e => { e.preventDefault(); load() }}>Try again</a>
          </Banner>
        )}
        {!data && !loadError && <SkeletonRows rows={2} />}
        {data && data.directories.length === 0 && (
          <div className="settings-row settings-row-plain">
            <div className="sr-sub">None yet. Suggestions are the people who have signed in until you import one.</div>
          </div>
        )}
        {data?.directories.map(d => (
          <Row
            key={d.tenantId}
            title={`${d.tenantId} — ${plural(d.count, 'person', 'people')}`}
            sub={[
              d.importedAt ? `Imported ${new Date(d.importedAt).toLocaleString()}` : '',
              d.importedBy ? `by ${d.importedBy}` : '',
              d.fileName ? `from ${d.fileName}` : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className="action-row">
              <Button variant="ghost" onClick={() => exportCsv(d.tenantId)} title="Download as CSV">
                <Icon name="download" size={14} /> CSV
              </Button>
              <Button variant="ghost" onClick={() => { setTenant(d.tenantId); invalidate() }} title="Refresh this directory from a new file">
                Refresh
              </Button>
              <Button variant="danger-ghost" onClick={() => remove(d.tenantId, d.count)}>
                <Icon name="x" size={14} /> Remove
              </Button>
            </div>
          </Row>
        ))}
      </Group>

      <Group
        title="Import or refresh"
        hint="An import replaces the tenant's directory: people missing from the file are removed, so re-importing a fresh export is how leavers drop out."
      >
        <Row title="Tenant" sub="The email domain whose people will see this list. Entries may be at any domain.">
          <input
            className="input"
            value={tenant}
            onChange={e => { setTenant(e.target.value); invalidate() }}
            placeholder="example.com"
            spellCheck={false}
          />
        </Row>
        <Row
          title={pasting ? 'Paste' : 'File'}
          sub={
            pasting
              ? 'CSV text, or a recipient list: Ann Lee <ann@example.com>; …'
              : 'CSV from Entra or Microsoft 365 admin (Users → Download/Export users), Outlook or Google contacts export, Google Workspace users, or any sheet with a Name and an Email column.'
          }
          stacked={pasting}
        >
          {pasting ? (
            <textarea
              className="input"
              rows={6}
              value={paste}
              onChange={e => { setPaste(e.target.value); invalidate() }}
              placeholder={'Name,Email\nAnn Lee,ann@example.com'}
              spellCheck={false}
            />
          ) : (
            // The native control cannot be themed (its button is browser
            // chrome), so it is visually hidden and driven by our own Button;
            // the label keeps it reachable by keyboard and screen readers.
            <div className="dir-file">
              <input
                ref={fileRef}
                id="dir-file-input"
                className="sr-only"
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                onChange={pick}
              />
              <Button type="button" onClick={() => fileRef.current?.click()}>
                <Icon name="upload" size={14} /> {file ? 'Change file' : 'Choose file'}
              </Button>
              <label htmlFor="dir-file-input" className="dir-file-name">
                {file ? file.name : 'No file chosen'}
              </label>
            </div>
          )}
        </Row>
        <ActionRow>
          <a href="#" onClick={e => { e.preventDefault(); setPasting(p => !p); invalidate() }}>
            {pasting ? 'Upload a file instead' : 'Paste a list instead'}
          </a>
          <Button onClick={runPreview} disabled={busy || !source || !tenant.trim()}>
            {busy && !preview ? 'Reading…' : 'Preview'}
          </Button>
        </ActionRow>

        {error && <Banner kind="danger">{error}</Banner>}

        {preview && (
          <>
            <Preview p={preview} />
            {preview.needsForce && (
              <label className="settings-row settings-row-plain">
                <input type="checkbox" checked={force} onChange={e => setForce(e.target.checked)} />{' '}
                I understand this removes {preview.counts.removed} of the {preview.counts.existing} people in the
                directory.
              </label>
            )}
            <ActionRow>
              <Button
                variant="primary"
                onClick={runImport}
                disabled={busy || !preview.counts.entries || (preview.needsForce && !force)}
              >
                {busy ? 'Importing…' : `Import ${plural(preview.counts.entries, 'person', 'people')} into ${preview.tenantId}`}
              </Button>
            </ActionRow>
          </>
        )}
      </Group>
    </Section>
  )
}
