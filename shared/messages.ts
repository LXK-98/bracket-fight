// Messages the server can send to clients (errors and lobby status). The server
// sends a code plus parameters; browsers translate the code (see client/src/i18n).
// These English texts are the source: the server uses them for its own `error`
// field, and the client uses them as the English translation.
// Placeholders use i18next syntax ({{name}}); `_one`/`_other` keys are plural forms.

export const MESSAGES = {
  // Joining and players
  roomNotFound: 'Room not found. Check the code.',
  nameRequired: 'Please enter a name.',
  nameTaken: 'That name is already taken in this room.',
  roomFull: 'This room is full.',
  notInRoom: 'You are no longer in this room.',
  sessionExpired: 'Session expired. Please join again.',
  unknownPlayer: 'Unknown player. Please rejoin.',
  playerNotFound: 'Player not found.',
  notHost: 'You are not the host of this room.',
  hostOnly: 'Only the host can do that.',
  playersOnly: 'Only players can do that.',
  notConnected: 'Not connected to a room.',

  // Lobby and entries
  gameStarted: 'The game has already started.',
  bracketFull: 'The bracket is full ({{max}} entries). You can still vote!',
  notCompetitor: 'Choose "Compete" before submitting an entry.',
  textOnly: 'This room only allows text entries.',
  imageRequired: 'Please add an image.',
  textRequired: 'Please enter some text.',
  entryEmpty: 'Add an image or some text.',
  needTwoCompetitors: 'Need at least 2 competitors ({{current}} so far).',
  tooManyCompetitors: 'Too many competitors ({{current}}) for a bracket of {{max}}. Raise the max or ask someone to just vote.',
  waitingForEntries_one: 'Waiting for {{count}} competitor to submit an entry.',
  waitingForEntries_other: 'Waiting for {{count}} competitors to submit an entry.',

  // Game flow
  nothingToPause: 'Nothing to pause.',
  notPaused: 'The game is not paused.',
  noVoteRunning: 'No vote is running.',
  nothingToAdvance: 'Nothing to advance.',
  pickWinner: 'Pick a winner to break the tie.',
  noTie: 'There is no tie to break.',
  unknownEntry: 'Unknown entry.',
  gameOver: 'The game is over.',
  votingClosed: 'Voting for this matchup is closed.',
  gamePaused: 'The game is paused.',
  ownMatchup: "You can't vote in your own matchup.",

  // Uploads
  imageTooLarge: 'Image is too large (max {{mb}} MB).',
  unsupportedImage: 'Unsupported image type. Use JPEG, PNG, WebP or GIF.',
  invalidUpload: 'Invalid upload.',
  uploadFailed: 'Upload failed.',

  // Room creation
  passwordRequired: 'A password is required to create a room.',
  wrongPassword: 'Wrong password.',
  passwordLocked: 'Too many wrong passwords. Try again in a few minutes.',
  serverFull: 'Server is full, try again later.',

  // Limits and generic
  tooManyRooms: 'Too many rooms created, slow down.',
  tooManyJoins: 'Too many people joining at once, try again in a moment.',
  tooManyUploads: 'Too many uploads, wait a moment and try again.',
  slowDown: 'Slow down a little.',
  invalidRequest: 'Invalid request.',
  badRequest: 'Bad request.',
  notFound: 'Not found.',
  serverError: 'Something went wrong.',
} as const;

type PluralBase<K> = K extends `${infer B}_one` | `${infer B}_other` ? B : K;

/** A message code, e.g. "roomNotFound" or "waitingForEntries" (plural forms share one code). */
export type MessageCode = PluralBase<keyof typeof MESSAGES>;
export type MessageParams = Record<string, string | number>;

/** A message as sent to clients: the code and parameters to translate, plus the English text. */
export interface Problem {
  code: MessageCode;
  params?: MessageParams;
  message: string;
}

const plural = new Intl.PluralRules('en');
const table = MESSAGES as Record<string, string>;

/** English text for a message code, with i18next-style placeholders and plurals filled in. */
export function formatMessage(code: MessageCode, params: MessageParams = {}): string {
  const count = params.count;
  const template =
    (typeof count === 'number' ? table[`${code}_${plural.select(count)}`] : undefined) ??
    table[`${code}_other`] ??
    table[code] ??
    code;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => (key in params ? String(params[key]) : match));
}

export function problem(code: MessageCode, params?: MessageParams): Problem {
  return params ? { code, params, message: formatMessage(code, params) } : { code, message: formatMessage(code) };
}
