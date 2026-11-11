const http=require('http'),fs=require('fs');
http.createServer((req,res)=>{res.end(fs.readFileSync('/evidence/'+process.env.LEG+'.sh'));}).listen(18863,'127.0.0.1');
