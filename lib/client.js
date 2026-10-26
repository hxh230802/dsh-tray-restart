window.__ModuleLoader__.load({
  id: 'dsh-tray-restart',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const ROUTE = '/plugins/dsh-tray-restart'

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      muted: 'var(--dsw-alias-label-secondary, inherit)',
      faint: 'var(--dsw-alias-label-tertiary, inherit)',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,0.24))',
      surface: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06))',
      accent: 'var(--dsw-alias-state-business-primary, #2563eb)',
      ok: 'var(--dsw-alias-state-success-primary, #2f9e6b)',
      warn: 'var(--dsw-alias-state-warning-primary, #d97706)',
      danger: 'var(--dsw-alias-state-error-primary, #d9534f)',
    }

    const rowStyle = {
      display: 'flex',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: '16px',
      padding: '12px 0',
      borderTop: `1px solid ${C.border}`,
    }
    const firstRowStyle = { ...rowStyle, borderTop: 'none' }
    const labelStyle = { fontSize: '14px', color: C.text, flex: '0 0 auto' }
    const valueStyle = {
      fontSize: '13px',
      color: C.muted,
      textAlign: 'right',
      wordBreak: 'break-all',
      maxWidth: '64%',
      lineHeight: '1.5',
    }
    const hintStyle = { fontSize: '12px', color: C.faint, margin: '2px 0 0' }

    function buttonStyle(primary, disabled) {
      return {
        appearance: 'none',
        border: `1px solid ${primary ? 'transparent' : C.border}`,
        background: primary ? C.accent : C.surface,
        color: primary ? '#fff' : C.text,
        borderRadius: '8px',
        padding: '6px 12px',
        fontSize: '13px',
        lineHeight: '20px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
      }
    }

    function toneColor(tone) {
      if (tone === 'ok') return C.ok
      if (tone === 'warn') return C.warn
      if (tone === 'danger') return C.danger
      return C.muted
    }

    function Badge({ tone, children }) {
      return React.createElement(
        'span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '1px 8px',
            borderRadius: '999px',
            fontSize: '12px',
            lineHeight: '20px',
            color: toneColor(tone),
            background: C.surface,
            border: `1px solid ${C.border}`,
            whiteSpace: 'nowrap',
          },
        },
        [
          React.createElement('span', {
            key: 'dot',
            style: { width: '6px', height: '6px', borderRadius: '50%', background: toneColor(tone) },
          }),
          children,
        ],
      )
    }

    function Row({ label, children, first }) {
      return React.createElement(
        'div',
        { style: first ? firstRowStyle : rowStyle },
        React.createElement('span', { style: labelStyle }, label),
        React.createElement('span', { style: valueStyle }, children),
      )
    }

    function statusView(status) {
      if (!status) return { label: '读取中…', tone: 'muted', hint: '' }
      switch (status.state) {
        case 'patched':
        case 'already-patched':
          return { label: '已打补丁', tone: 'ok', hint: '重启 DSH 后菜单生效' }
        case 'unpatched':
          return { label: '未打补丁', tone: 'warn', hint: '下次 Host 启动会自动补' }
        case 'dry-run':
          return { label: 'dry-run 通过', tone: 'warn', hint: '未写入 app.asar' }
        case 'restored':
        case 'restored-hold':
          return { label: '已还原（自动补丁暂停）', tone: 'muted', hint: '点「立即打补丁」恢复' }
        case 'already-original':
          return { label: '已是原始菜单', tone: 'muted', hint: '' }
        case 'skipped':
          return { label: '非桌面端，跳过', tone: 'muted', hint: '只在打包的 Windows 桌面端生效' }
        case 'failed':
          return { label: '失败', tone: 'danger', hint: status.reason || '' }
        default:
          return { label: String(status.state || '未知'), tone: 'muted', hint: status.reason || '' }
      }
    }

    function request(path, method) {
      return fetch(ROUTE + path, {
        method,
        headers: { accept: 'application/json' },
      }).then(async (response) => {
        const text = await response.text()
        let payload
        try {
          payload = text ? JSON.parse(text) : {}
        } catch {
          throw new Error(text.slice(0, 200) || `HTTP ${response.status}`)
        }
        if (!response.ok || payload.ok === false) {
          const reason = payload.status && payload.status.reason ? payload.status.reason : payload.error
          throw new Error(reason || `HTTP ${response.status}`)
        }
        return payload
      })
    }

    function ConfigCard(props) {
      const view = props && props.view
      const [status, setStatus] = React.useState(null)
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(() => {
        setLoading(true)
        request('/status', 'GET')
          .then((payload) => setStatus(payload.status))
          .catch((error) => setNotice({ tone: 'danger', text: String(error.message || error) }))
          .finally(() => setLoading(false))
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      const act = (path, message) => {
        setBusy(path)
        setNotice(null)
        request(path, 'POST')
          .then((payload) => {
            if (payload.status) setStatus(payload.status)
            setNotice({ tone: 'ok', text: message })
          })
          .catch((error) => setNotice({ tone: 'danger', text: String(error.message || error) }))
          .finally(() => {
            setBusy('')
            load()
          })
      }

      if (view === 'summary') {
        return React.createElement('span', null, '把「重启 DeepSeek Harness」加进桌面端现有的托盘与应用菜单。')
      }

      const state = statusView(status)
      const config = (status && status.config) || {}
      const disabled = Boolean(busy)

      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', width: '100%' } },
        React.createElement(
          'div',
          { style: firstRowStyle },
          React.createElement('span', { style: labelStyle }, '补丁状态'),
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' } },
            loading && !status
              ? React.createElement('span', { style: valueStyle }, '读取中…')
              : React.createElement(Badge, { tone: state.tone }, state.label),
            state.hint ? React.createElement('span', { style: hintStyle }, state.hint) : null,
          ),
        ),
        React.createElement(Row, { label: '桌面端版本' }, (status && status.appVersion) || '—'),
        React.createElement(Row, { label: '补丁版本' }, status ? `v${status.patchVersion}` : '—'),
        React.createElement(Row, { label: 'app.asar' }, (status && status.asarPath) || '—'),
        React.createElement(Row, { label: '备份' }, status && status.backupAvailable ? status.backupDir : '无'),
        React.createElement(Row, { label: '日志' }, (status && status.logPath) || '—'),
        React.createElement(Row, { label: '自动检查' }, config.enabled === false ? '关' : '开'),
        React.createElement(Row, { label: '写入前语法校验' }, config.verifySyntax === false ? '关' : '开'),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', padding: '14px 0 4px' } },
          React.createElement(
            'button',
            {
              type: 'button',
              style: buttonStyle(false, disabled),
              disabled,
              onClick: () => {
                setNotice(null)
                load()
              },
            },
            '重新检查',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              style: buttonStyle(true, disabled),
              disabled,
              onClick: () => act('/apply', '补丁已写入，重启 DSH 后生效。'),
            },
            busy === '/apply' ? '写入中…' : '立即打补丁',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              style: buttonStyle(false, disabled),
              disabled,
              onClick: () => act('/restore', '已还原原始菜单，自动补丁暂停。'),
            },
            busy === '/restore' ? '还原中…' : '还原原始菜单',
          ),
        ),
        notice
          ? React.createElement(
              'p',
              {
                style: {
                  margin: '4px 0 0',
                  fontSize: '12px',
                  color: notice.tone === 'ok' ? C.ok : C.danger,
                },
                role: 'status',
              },
              notice.text,
            )
          : null,
        React.createElement(
          'p',
          { style: { ...hintStyle, marginTop: '10px', lineHeight: '1.6' } },
          '补丁写入后需要重启一次 DSH 才会显示新菜单；应用更新后插件会在下次启动时自动重新打。还原会暂停自动补丁，直到点「立即打补丁」。',
        ),
      )
    }

    async function apply(ctx) {
      let slots
      for (let i = 0; i < 80; i += 1) {
        try {
          slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
        } catch {
          slots = undefined
        }
        if (slots) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (!slots) {
        console.warn('[dsh-tray-restart] slots service unavailable; plugin page card not registered')
        return
      }

      const install = () =>
        slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-tray-restart',
            label: () => '托盘重启',
          },
          ConfigCard,
        )

      if (typeof ctx.effect === 'function') {
        ctx.effect(() => slots.inject('plugins.bundle.config', install), 'dsh-tray-restart: bundle config card')
      } else {
        slots.inject('plugins.bundle.config', install)
      }
    }

    module.exports = { name: 'dsh-tray-restart', inject: ['slots'], apply }
    return module.exports
  },
})
