// The build's file loader turns these imports into the url the daemon serves them at.
declare module '*.png' {
  const url: string
  export default url
}
declare module '*.jpg' {
  const url: string
  export default url
}
declare module '*.webp' {
  const url: string
  export default url
}
declare module '*.svg' {
  const url: string
  export default url
}
declare module '*.mp4' {
  const url: string
  export default url
}
declare module '*.webm' {
  const url: string
  export default url
}
