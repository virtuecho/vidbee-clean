const GLOBAL_OPERATIONAL_PATTERNS = ['ffmpeg not initialized. call initialize() first.']

const DOWNLOAD_OPERATIONAL_PATTERNS = [
  'could not copy chrome cookie database',
  'failed to decrypt with dpapi',
  'could not find firefox cookies database',
  "sign in to confirm you're not a bot",
  'sign in to confirm you’re not a bot',
  'unsupported url',
  'video unavailable',
  'requested format is not available',
  'requested range not satisfiable',
  'invalid data found when processing input',
  'unable to rename file',
  'winerror 32',
  'winerror 2',
  'read timed out',
  'connect etimedout',
  'failed to resolve',
  'eof occurred in violation of protocol',
  'net::err_connection_reset',
  'net::err_timed_out'
]

const SUBSCRIPTION_OPERATIONAL_PATTERNS = [
  'status code 404',
  'request timed out after 60000ms',
  'aggregateerror',
  'attribute without value',
  'unexpected close tag',
  'feed not recognized as rss 1 or 2.',
  'invalid character in tag name',
  'net::err_connection_reset',
  'net::err_timed_out',
  'net::err_name_not_resolved',
  'net::err_proxy_connection_failed',
  'net::err_internet_disconnected',
  'client network socket disconnected before secure tls connection was established',
  'connect etimedout'
]

interface TelemetryContextShape {
  tags?: Record<string, boolean | number | string | undefined>
}

interface TelemetryEventExceptionValue {
  type?: string
  value?: string
}

interface TelemetryEventShape {
  exception?: {
    values?: TelemetryEventExceptionValue[]
  }
  message?: string
  tags?: Record<string, unknown>
}

/**
 * Normalize telemetry text so pattern matching is stable across platforms.
 *
 * @param value The raw telemetry text.
 * @returns The normalized lowercase text.
 */
const normalizeTelemetryText = (value: string | undefined | null): string => {
  return value?.trim().toLowerCase() ?? ''
}

/**
 * Read the telemetry source tag from Sentry scope or event tags.
 *
 * @param tags The telemetry tags bag.
 * @returns The normalized source tag.
 */
const readSourceTag = (tags: Record<string, unknown> | undefined): string => {
  const source = tags?.source
  return typeof source === 'string' ? normalizeTelemetryText(source) : ''
}

/**
 * Check whether any normalized message contains one of the known patterns.
 *
 * @param messages The normalized telemetry messages.
 * @param patterns The operational error patterns to match.
 * @returns True when a known pattern is present.
 */
const matchesAnyPattern = (messages: string[], patterns: string[]): boolean => {
  return patterns.some((pattern) => messages.some((message) => message.includes(pattern)))
}

/**
 * Build a list of normalized messages from an error object and optional plain message.
 *
 * @param error The error candidate captured by telemetry.
 * @param fallbackMessage An additional plain-text message to inspect.
 * @returns Normalized non-empty message fragments.
 */
const collectErrorMessages = (error: unknown, fallbackMessage?: string): string[] => {
  const messages = new Set<string>()

  if (typeof fallbackMessage === 'string') {
    const normalizedFallback = normalizeTelemetryText(fallbackMessage)
    if (normalizedFallback) {
      messages.add(normalizedFallback)
    }
  }

  if (error instanceof Error) {
    const normalizedName = normalizeTelemetryText(error.name)
    const normalizedMessage = normalizeTelemetryText(error.message)
    const normalizedStack = normalizeTelemetryText(error.stack)

    if (normalizedName) {
      messages.add(normalizedName)
    }
    if (normalizedMessage) {
      messages.add(normalizedMessage)
    }
    if (normalizedStack) {
      messages.add(normalizedStack)
    }
  } else if (typeof error === 'string') {
    const normalizedError = normalizeTelemetryText(error)
    if (normalizedError) {
      messages.add(normalizedError)
    }
  }

  return [...messages]
}

/**
 * Build a list of normalized messages from a telemetry event payload.
 *
 * @param event The telemetry event candidate.
 * @returns Normalized non-empty event message fragments.
 */
const collectEventMessages = (event: TelemetryEventShape): string[] => {
  const messages = new Set<string>()
  const normalizedMessage = normalizeTelemetryText(event.message)

  if (normalizedMessage) {
    messages.add(normalizedMessage)
  }

  for (const value of event.exception?.values ?? []) {
    const normalizedType = normalizeTelemetryText(value.type)
    const normalizedValue = normalizeTelemetryText(value.value)

    if (normalizedType) {
      messages.add(normalizedType)
    }
    if (normalizedValue) {
      messages.add(normalizedValue)
    }
    if (normalizedType && normalizedValue) {
      messages.add(`${normalizedType}: ${normalizedValue}`)
    }
  }

  return [...messages]
}

/**
 * Determine whether a telemetry payload is an expected operational issue.
 *
 * @param messages The normalized telemetry message fragments.
 * @param source The normalized telemetry source tag.
 * @returns True when the payload should be dropped from Sentry issue reporting.
 */
const isOperationalTelemetry = (messages: string[], source: string): boolean => {
  if (matchesAnyPattern(messages, GLOBAL_OPERATIONAL_PATTERNS)) {
    return true
  }

  if (source.startsWith('download') || source === 'one-click-download') {
    return matchesAnyPattern(messages, DOWNLOAD_OPERATIONAL_PATTERNS)
  }

  if (source.startsWith('subscription')) {
    return matchesAnyPattern(messages, SUBSCRIPTION_OPERATIONAL_PATTERNS)
  }

  return false
}

/**
 * Decide whether an exception should be skipped before sending it to Sentry.
 *
 * @param error The captured error candidate.
 * @param context The telemetry context carrying tags.
 * @param message The optional plain-text message being captured.
 * @returns True when the issue is expected and should not create a Sentry issue.
 */
export const shouldSkipTelemetryError = (
  error: unknown,
  context?: TelemetryContextShape,
  message?: string
): boolean => {
  const source = readSourceTag(context?.tags)
  const messages = collectErrorMessages(error, message)
  return isOperationalTelemetry(messages, source)
}

/**
 * Decide whether a finalized Sentry event should be dropped before transport.
 *
 * @param event The Sentry event payload.
 * @returns True when the event is expected operational noise.
 */
export const shouldDropTelemetryEvent = (event: TelemetryEventShape): boolean => {
  const source = readSourceTag(event.tags)
  const messages = collectEventMessages(event)
  return isOperationalTelemetry(messages, source)
}
