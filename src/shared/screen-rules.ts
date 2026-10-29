// JSON-compatible data: also read by the on-device Python detector.
export const screenRules = {
  "name": "screen[ _-]?(recording|capture|cast)|screencast|desktop[ _-]?recording|display[ _-]?recording|quicktime|(^|[/ _-])(obs|loom)([/ _.-]|$)|^[0-9]{4}-[0-9]{2}-[0-9]{2}[ _][0-9]{2}[-:][0-9]{2}[-:][0-9]{2}",
  "description": "screen recording|screencast|desktop recording|display recording",
  "tags": ["screen recording", "screen_recording", "screencast"],
  "uiTags": ["computer screen", "user interface", "cursor", "web browser", "website"],
  "displays": [[1440,900],[1680,1050],[2560,1600],[2880,1800],[3024,1964],[3456,2234],[5120,2880],[1728,1117],[1512,982]]
};
