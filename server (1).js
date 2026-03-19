const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req,res)=>{res.writeHead(200);res.end('Tank CTF Signaling Server');});
const wss = new WebSocket.Server({server});

// rooms[code] = { host: ws, clients: {slot: ws} }
const rooms = {};

function genCode(){return Math.random().toString(36).substring(2,8).toUpperCase();}
function send(ws,obj){if(ws&&ws.readyState===1)ws.send(JSON.stringify(obj));}

wss.on('connection', ws => {
  let myRoom=null, mySlot=-1, myCode='';

  ws.on('message', raw => {
    let msg; try{msg=JSON.parse(raw);}catch{return;}

    // HOST creates room
    if(msg.type==='host'){
      const code=genCode();
      rooms[code]={host:ws, clients:{0:ws}, slots:[0]};
      myRoom=rooms[code]; mySlot=0; myCode=code;
      send(ws,{type:'hosted',code,slot:0});
    }

    // CLIENT joins room
    else if(msg.type==='join'){
      const room=rooms[msg.code];
      if(!room){send(ws,{type:'error',msg:'Room not found'});return;}
      if(room.clients[msg.slot]){send(ws,{type:'error',msg:'Slot taken'});return;}
      myRoom=room; mySlot=msg.slot; myCode=msg.code;
      room.clients[msg.slot]=ws;
      room.slots.push(msg.slot);
      send(ws,{type:'joined',slot:msg.slot,code:msg.code});
      // Tell everyone about new player
      Object.values(room.clients).forEach(c=>send(c,{type:'players',slots:room.slots}));
      // Tell new player about existing players so WebRTC can start
      send(ws,{type:'existing',slots:room.slots.filter(s=>s!==msg.slot)});
    }

    // START game
    else if(msg.type==='start'){
      if(myRoom&&mySlot===0){
        Object.values(myRoom.clients).forEach(c=>send(c,{type:'start'}));
      }
    }

    // WebRTC SIGNALING — just forward to correct player
    else if(msg.type==='signal'){
      const room=rooms[msg.code||myCode];
      if(!room)return;
      const target=room.clients[msg.to];
      if(target)send(target,{type:'signal',from:mySlot,...msg.data});
    }
  });

  ws.on('close',()=>{
    if(myRoom){
      delete myRoom.clients[mySlot];
      myRoom.slots=myRoom.slots.filter(s=>s!==mySlot);
      Object.values(myRoom.clients).forEach(c=>send(c,{type:'players',slots:myRoom.slots}));
      if(Object.keys(myRoom.clients).length===0)delete rooms[myCode];
    }
  });
});

server.listen(PORT,()=>console.log(`Signaling server on port ${PORT}`));
