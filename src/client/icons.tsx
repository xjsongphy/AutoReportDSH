/**
 * The icons AutoReport draws for itself.
 *
 * DSH's own set is the first choice for a tool row, but it has no glyph for "a
 * specialist reports its task outcome". This file holds the exceptions, drawn
 * in the same idiom as `@deepseek-ai/dsh-client-ui-primitives`: a figma-extract
 * outline built as compound filled paths on `currentColor`, no stroke, and a
 * viewBox sized to the figma grid. The shell's `DisclosureRow` CSS scales every
 * leading svg to the row's 14px box, so a component takes no size prop.
 *
 * @module autoreportdsh/icons
 */

/**
 * A pennant flag: a specialist reporting the outcome of its task.
 * @returns the flag glyph.
 */
export function IconFlagOutline14() {
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* The staff: a round-capped bar from the top of the glyph to its base. */}
      <path d="M2.6 1.7a0.5 0.5 0 0 1 1 0v10.6a0.5 0.5 0 0 1-1 0Z" fill="currentColor" />
      {/* The banner: a swallowtail fly, so the glyph still reads as a flag at 14px. */}
      <path d="M3.6 2.2H12.4L10.3 4.5L12.4 6.8H3.6Z" fill="currentColor" />
    </svg>
  )
}
