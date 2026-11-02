// Keep a bounded number of real pages. Scrolling/selection anchors belong to
// the view; cursors and immutable page membership belong to the backend.
export class PageWindow {
 constructor(page,maxPages=5){this.maxPages=maxPages;this.pages=[page]}
 get first(){return this.pages[0]}
 get last(){return this.pages[this.pages.length-1]}
 get items(){return this.pages.flatMap(page=>page.items)}
 cursorFor(path){return (this.pages.find(page=>page.items.some(item=>item.path===path))||this.first).page.cursor}
 add(page,direction){
  const expected=direction==='next'?this.last.page.nextCursor:this.first.page.previousCursor;
  if(!expected||expected!==page.page.cursor)throw new Error('目录页面不属于当前连续快照，请刷新');
  if(direction==='next'){this.pages.push(page);if(this.pages.length>this.maxPages)this.pages.shift()}
  else{this.pages.unshift(page);if(this.pages.length>this.maxPages)this.pages.pop()}
 }
}
