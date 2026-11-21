// The parts of fontkit (MIT) that Tinto uses to read a font the writer adds.
declare module 'fontkit' {
  export interface Font {
    type: string
    familyName: string
    subfamilyName: string
    postscriptName: string
    italicAngle: number
    variationAxes: Record<string, { name: string; min: number; default: number; max: number }>
    'OS/2'?: { usWeightClass?: number; fsSelection?: { italic?: boolean; oblique?: boolean } }
    getName(key: string, lang?: string): string | null
    hasGlyphForCodePoint(codePoint: number): boolean
  }
  export interface FontCollection { type: 'TTC' | 'DFont'; fonts: Font[] }
  export function create(buffer: Uint8Array, postscriptName?: string): Font | FontCollection
}
