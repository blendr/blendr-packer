var path = require('path');
var fs = require('fs');

module.exports = function() {
};

module.exports.prototype.pack = function(packId, files, destPath) {
	var out = {};

	for(var id in files) {
		var file = files[id];

		var filename = path.basename(file);
		fs.createReadStream(file).pipe(fs.createWriteStream(path.join(destPath, filename)));
		out[id] = filename;
	}

	return out;
};
