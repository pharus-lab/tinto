// The only file a site edits. See README.md in this folder.
export default {
  // The name Tinto shows in Settings → Websites.
  name: 'Example',
  // The site's public address. Tinto's publishing URL is site + basePath.
  site: 'https://example.com',
  basePath: '/api/tinto',
  // null accepts every language and uses its code as the locale (en, es…).
  // To map codes to the segments in your URLs, and refuse other languages:
  //   languages: { en: 'en', es: 'es' },
  languages: null,
  // Sections or pages a post can belong to, chosen in Tinto. null means none.
  // For example: categories: { blog: 'Blog', notes: 'Notes' },
  // A category can then be part of the post's address in postPath below.
  categories: null,
  // The public path of a post page, or null while the site has none. For example:
  //   postPath: post => '/' + post.locale + '/' + (post.category || 'blog') + '/' + post.slug,
  postPath: null
}
