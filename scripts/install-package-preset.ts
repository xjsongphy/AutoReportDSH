/** Install the preset after an npm package has been added to a DSH profile. */

import { install } from './install-user-preset.js'

install({
  packageName: 'autoreportdsh/preset',
  renderOverlay: false,
  linkPackage: false,
})
