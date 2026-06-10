import { SecretMaskingGuard } from '../secret-masking.guard'

describe('SecretMaskingGuard (Guard c)', () => {
  const guard = new SecretMaskingGuard()

  it('masks an OpenAI API key', () => {
    const r = guard.mask('key is sk-proj-abcdef0123456789ABCDEF0123 end')
    expect(r.maskedAny).toBe(true)
    expect(r.kinds).toContain('openai_api_key')
    expect(r.masked).not.toContain('sk-proj-abcdef')
    expect(r.masked).toContain('***MASKED:openai_api_key***')
  })

  it('masks an Anthropic API key (distinct from OpenAI)', () => {
    const r = guard.mask('claude sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa done')
    expect(r.kinds).toContain('anthropic_api_key')
    expect(r.masked).not.toContain('sk-ant-api03')
  })

  it('masks a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const r = guard.mask(`token=${jwt}`)
    expect(r.kinds).toContain('jwt')
    expect(r.masked).not.toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('masks a Bearer authorization value', () => {
    const r = guard.mask('Authorization: Bearer abcDEF1234567890ghiJKL')
    expect(r.kinds).toContain('bearer_token')
    expect(r.masked).not.toContain('abcDEF1234567890ghiJKL')
  })

  it('masks an AWS access key id', () => {
    const r = guard.mask('aws AKIAIOSFODNN7EXAMPLE here')
    expect(r.kinds).toContain('aws_access_key_id')
    expect(r.masked).not.toContain('AKIAIOSFODNN7EXAMPLE')
  })

  it('masks a GitHub token', () => {
    const r = guard.mask(
      'gh ghp_1234567890abcdefABCDEF1234567890abcdef done',
    )
    expect(r.kinds).toContain('github_token')
    expect(r.masked).not.toContain('ghp_1234567890abcdef')
  })

  it('masks an email address (PII)', () => {
    const r = guard.mask('contact john.doe@example.com please')
    expect(r.kinds).toContain('email')
    expect(r.masked).not.toContain('john.doe@example.com')
  })

  it('masks a credit card number', () => {
    const r = guard.mask('card 4111 1111 1111 1111 expiry')
    expect(r.kinds).toContain('credit_card')
    expect(r.masked).not.toContain('4111 1111 1111 1111')
  })

  it('returns maskedAny=false and original text when no secrets', () => {
    const text = 'BTCUSDT volume increased on the 1h timeframe.'
    const r = guard.mask(text)
    expect(r.maskedAny).toBe(false)
    expect(r.kinds).toEqual([])
    expect(r.masked).toBe(text)
  })

  it('handles empty string', () => {
    const r = guard.mask('')
    expect(r.masked).toBe('')
    expect(r.maskedAny).toBe(false)
  })

  it('masks multiple distinct secrets in one pass', () => {
    const r = guard.mask(
      'sk-proj-abcdef0123456789ABCDEF0123 and user@test.io and AKIAIOSFODNN7EXAMPLE',
    )
    expect(r.kinds).toEqual(
      expect.arrayContaining(['openai_api_key', 'email', 'aws_access_key_id']),
    )
  })

  it('maskMany aggregates kinds across inputs', () => {
    const r = guard.maskMany([
      'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa',
      'plain text',
      'mail a@b.co',
    ])
    expect(r.masked).toHaveLength(3)
    expect(r.kinds).toEqual(
      expect.arrayContaining(['anthropic_api_key', 'email']),
    )
    expect(r.masked[1]).toBe('plain text')
  })
})
