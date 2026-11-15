import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";
const db=createClient(SUPABASE_URL,SUPABASE_ANON_KEY);
const $=id=>document.getElementById(id);
let code="";
function message(id,text,error=false){const el=$(id);el.textContent=text;el.className="status"+(error?" error":"");el.classList.remove("hidden");}
$("continueBtn").onclick=loadQuestion;
$("code").addEventListener("keydown",e=>{if(e.key==="Enter")loadQuestion();});
async function loadQuestion(){
  code=$("code").value.trim().toUpperCase();
  if(!code)return message("entryMsg","Ingresa tu código.",true);
  $("continueBtn").disabled=true;
  const {data,error}=await db.rpc("get_active_question",{p_code:code});
  $("continueBtn").disabled=false;
  if(error)return message("entryMsg",error.message,true);
  $("entry").classList.add("hidden");$("ballot").classList.remove("hidden");
  $("question").textContent=data.question;
  $("options").innerHTML="";
  data.options.forEach((option,index)=>{
    const b=document.createElement("button");b.className="vote-option";b.textContent=option;
    b.onclick=()=>castVote(index,b);$("options").appendChild(b);
  });
  if(data.remaining_votes>1)message("voteMsg",`Este código permite ${data.remaining_votes} votos disponibles.`);
}
async function castVote(index,button){
  document.querySelectorAll(".vote-option").forEach(b=>b.disabled=true);
  const {data,error}=await db.rpc("submit_vote",{p_code:code,p_choice_index:index});
  if(error){message("voteMsg",error.message,true);document.querySelectorAll(".vote-option").forEach(b=>b.disabled=false);return;}
  $("options").innerHTML="";message("voteMsg","Tu voto ha sido registrado. Gracias por participar.");
}
