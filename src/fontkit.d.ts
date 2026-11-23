// The parts of fontkit (MIT) that Tinto uses to read a font the writer adds.
declare module 'fontkit' {
  export interface Font {
    type: string
    familyName: string
    subfamilyName: string
    postscriptName: string
    italicAngle: number
    variationAxes: Record<string, { name: string; min: number; default: number; max: number }>
    'OS/2'?: { usWeightClass?: number; fsSelection?: { italic?: boolean; oblique?: boolean }; fsType?: { noEmbedding?: boolean; viewOnly?: boolean; editable?: boolean }; panose?: number[] }
    post?: { isFixedPitch?: number }
    directory?: { tables?: Record<string, unknown> }
    getName(key: string, lang?: string): string | null
    hasGlyphForCodePoint(codePoint: number): boolean
  }
  export interface FontCollection { type: 'TTC' | 'DFont'; fonts: Font[] }
  export function create(buffer: Uint8Array, postscriptName?: string): Font | FontCollection
}

declare module 'pandoc-wasm' {
  export function convert(options: Record<string, unknown>, stdin: string | null, files: Record<string, Blob | string>): Promise<{ stderr: string; files: Record<string, Blob> }>
}
