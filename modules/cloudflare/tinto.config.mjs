// The only file a site edits. See README.md in this folder.
export default {
  // The name Tinto shows in Settings → Websites.
  name: 'Example',
  // The site's public address. Tinto's publishing URL is site + basePath.
  site: 'https://example.com',
  basePath: '/api/tinto',
  // Tinto language code → the locale this site uses in its URLs.
  // Posts in other languages are refused. Use null to accept every language.
  languages: { en: 'en', es: 'es' },
  // The public address of a post, or null while the site has no post pages.
  postPath: post => '/' + post.locale + '/blog/' + post.slug
}
