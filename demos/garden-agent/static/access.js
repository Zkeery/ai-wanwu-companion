"use strict";
const accessDialog = document.querySelector('#access-dialog');
const accessButton = document.querySelector('#account-button');
accessButton.addEventListener('click', () => {
  const existing = demoAccount.read();
  document.querySelector('#access-note').textContent = existing ? '果果和你的小花园，都在这里等你。' : '先用体验身份，和果果一起待一会儿。';
  document.querySelector('#access-enter').textContent=existing?'回到果果身边 ✧':'进入我的小世界 ✧';
  document.querySelector('#access-logout').hidden=!existing;
  document.querySelector('#access-error').hidden=true;
  accessDialog.showModal();
});
document.querySelector('#access-close').addEventListener('click',()=>accessDialog.close());
accessDialog.addEventListener('click',event=>{
  if(event.target!==accessDialog)return;
  const box=accessDialog.getBoundingClientRect();
  if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)accessDialog.close();
});
accessDialog.addEventListener('close',()=>accessButton.focus({preventScroll:true}));
document.querySelector('#access-enter').addEventListener('click',()=>{
  try {
    if(!demoAccount.read()){demoAccount.save('花园访客');location.assign('/#chat-experience');}
    else {accessDialog.close();document.querySelector('#chat-experience').scrollIntoView({block:'start'});document.querySelector('#chat-experience').focus({preventScroll:true});}
  }catch{const error=document.querySelector('#access-error');error.textContent='暂时无法保存体验身份，请重试。';error.hidden=false;}
});
document.querySelector('#access-logout').addEventListener('click',()=>{
  try{demoAccount.clear();location.assign('/');}
  catch{const error=document.querySelector('#access-error');error.textContent='暂时无法退出，请重试。';error.hidden=false;}
});
