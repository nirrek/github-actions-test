const { x, y, X, Y } = process.env;

// Do these types of logs in my script show up
// by default in Github UI or will I also have to
// do the weird secret setting shit to get it working
console.log(JSON.stringify(process.env, null, 2));
console.log('env variables', x, y, X, Y);