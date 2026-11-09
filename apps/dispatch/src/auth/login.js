const button = document.getElementById('passkey-button')
const notice = document.getElementById('passkey-error')
const webauthn = window.SimpleWebAuthnBrowser

const show = message => {
  notice.textContent = message
  notice.hidden = false
}

if (button && notice && webauthn && webauthn.browserSupportsWebAuthn()) {
  const form = button.form
  button.hidden = false
  button.addEventListener('click', async () => {
    notice.hidden = true
    button.disabled = true
    try {
      const options = await fetch('/auth/passkey/generate-authenticate-options', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      if (!options.ok) throw new Error('The server did not start a passkey sign-in.')
      const response = await webauthn.startAuthentication({ optionsJSON: await options.json() })
      form.elements.namedItem('passkey').value = JSON.stringify(response)
      form.submit()
    } catch (error) {
      button.disabled = false
      show(error instanceof Error && error.name === 'NotAllowedError' ? 'The passkey prompt was closed or no passkey for this site was found.' : error instanceof Error ? error.message : 'The passkey was not accepted.')
    }
  })
}
