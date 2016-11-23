var yaml = require('js-yaml');
var fs = require('fs');
var path = require('path');
var mkdirp = require('mkdirp');
var execSync = require('child_process').execSync;
var tmp = require('tmp');

// default packer
var rawPacker = require('./raw-packer.js');


// get list of all files/dirs and their packer types
function listFiles(dir, rootDir) {
	if(!rootDir) {
		rootDir = path.join(dir, '/');
	}

	var files = fs.readdirSync(dir);

	var flatFiles = {};

	files.forEach(function(file) {
		var type = '';
		var id = file;
		var src = path.join(dir, file).replace(rootDir, '');

		// extract packer type from name
		var pos = file.lastIndexOf('#');
		if(pos >= 0) {
			id = file.substr(0, pos);
			type = file.substr(pos+1);

			if(id.trim().length <= 0) {
				id = type;
			}
		}

		if(fs.statSync(path.join(dir, file)).isDirectory()) {
			flatFiles[id] = {
				type: type,
				isDir: true,
				src: src,
				files: listFiles(path.join(dir, file), rootDir)
			};
		} else {
			// remove filename extension
			if(!root.isDir) {
				id = id.replace(/\.[^/.]+$/, '');
			}

			flatFiles[id] = {
				type: type,
				isDir: false,
				src: src,
				files: {}
			};
		}
	});

	return flatFiles;
}

function generateLoadMap(packers, packs, root, id, defaultType) {
	if(typeof id === 'undefined')
		id = '';
	if(typeof defaultType === 'undefined')
		defaultType = 'raw';

	// default loader is 'raw'
	var packerType = !packers[root.type] && !root.isDir ? defaultType : root.type;
	var packer = packers[packerType];

	var files = {};
	var includes = [];
	var dependencies = [];

	if(root.files) {
		for(var name in root.files) {
			var file = root.files[name];
			var localId = id + (id.length>0?'-':'') + name;

			var ret = generateLoadMap(packers, packs, file, localId, packer?'':defaultType);

			if(ret && ret != id) {
				includes.push(ret);
			} else {
				files[localId] = file.src;
			}
		}
	}

	if(packer) {
		// lonely file, store it by packer type
		if(!root.isDir && Object.keys(files).length <= 0) {
			files[id] = root.src;
			id = packerType;
		}

		var pack = packs[id];
		if(pack) {
			// pack already exists, concatenate them
			pack = {
				type: packerType,
				includes: pack.includes.concat(includes),
				dependencies: pack.dependencies.concat(dependencies),
				files: Object.assign({}, pack.files, files)
			};
			packs[id] = pack;
		} else {
			packs[id] = {
				type: packerType,
				dependencies: dependencies,
				includes: includes,
				files: files
			};
		}

		return id;
	} else if(packerType && packerType.length > 0) {
		console.warn('unknown packer: ' + packerType + ' (' + root.src + ')');
	}

	return null;
}

// compute files infos and type
function computeFileInfos(srcDir) {
	var walkSync = function (dir, filelist) {
		var fs = fs || require('fs'),
			files = fs.readdirSync(dir);
		filelist = filelist || {};
		files.forEach(function (file) {
			var filename = path.join(dir, file);

			if (fs.statSync(filename).isDirectory()) {
				filelist = walkSync(path.join(dir, file), filelist);
			} else {
				var stats = fs.statSync(filename);
				var fileSizeInBytes = stats["size"];

				// remove dest dir from filename
				filename = filename.substr(path.join(srcDir).length);

				// file type
				var ext = path.extname(filename);
				var type = '';
				if(['.jpeg', '.jpg', '.png', '.gif'].indexOf(ext) >= 0) {
					type = 'image';
				} else if(['.json'].indexOf(ext) >= 0) {
					type = 'json';
				} else if(['.html', '.txt'].indexOf(ext) >= 0) {
					type = 'text';
				} else if(['.xml'].indexOf(ext) >= 0) {
					type = 'xml';
				} else if(['.pack'].indexOf(ext) >= 0) {
					type = 'arraybuffer';
				} else {
					type = ext.substr(1);
				}

				filelist[filename] = {
					type: type,
					size: fileSizeInBytes
				};
			}
		});
		return filelist;
	};

	return walkSync(srcDir, {});
}

function packIt(packs, packId, srcDir, destDir, assets, packers) {
	var pack = packs[packId];
	var packer = packers[pack.type];

	// transform files to absolute
	for(var id in pack.files) {
		var file = pack.files[id];
		pack.files[id] = path.join(srcDir, file);
	}

	// check includes
	if(pack.includes) {
		for (var i = 0; i < pack.includes.length; i++) {
			var include = packs[pack.includes[i]];

			// pack dependency
			if (!include.packed) {
				packIt(packs, include.id, srcDir, destDir, assets, packers);
			}

			// add dependent files from referenced pack
			for (var id in packs[include.id].outputFiles) {
				var file = packs[include.id].outputFiles[id];
				var absoluteFile = packs[include.id].absoluteFiles[id];
				pack.files[file] = absoluteFile;
			}
		}
	}

	// create pack files
	pack.outputFiles = packer.pack(packId, pack.files, destDir);
	pack.packed = true;

	// transform output files to absolute
	pack.absoluteFiles = {};
	for(var id in pack.outputFiles) {
		var file = pack.outputFiles[id];
		pack.absoluteFiles[id] = path.join(destDir, file);
	}

	// store pack infos
	assets.packs[pack.id] = {
		type: pack.type,
		dependencies: pack.dependencies ? pack.dependencies : [],
		includes: pack.includes,
		files: pack.outputFiles
	};

	if(pack.includes) {
		for (var i = 0; i < pack.includes.length; i++) {
			var refId = pack.includes[i];
			assets.packs[refId].dependencies.push(pack.id);
		}
	}
}

function cleanUseless(packs, destDir, assets, packers) {
	// find potential useless files to clean (like packs in packs)
	for(var id in packs) {
		var pack = packs[id];

		// includes can be deleted if packer accepts it and no dependency references it
		if(pack.includes && packers[pack.type].virtualChildren) {
			for (var i = 0; i < pack.includes.length; i++) {
				var refId = pack.includes[i];
				var ref = packs[refId];

				if(typeof packs[refId].virtual === 'undefined') {
					packs[refId].virtual = true;
				}
			}
		}

		// dependencies MUST be physically present
		if(pack.dependencies) {
			for (var i = 0; i < pack.dependencies.length; i++) {
				var refId = pack.dependencies[i];
				var ref = packs[refId];

				ref.virtual = false;
			}
		}
	}

	// clean useless files
	for(var id in packs) {
		var pack = packs[id];
		var asset = assets.packs[id];

		if(pack.virtual) {
			for(var name in asset.files) {
				fs.unlinkSync(path.join(destDir, asset.files[name]));
			}
		}
	}
}

function Packr(packers) {
	// default packers
	this.packers = {
		raw: new rawPacker()
	};
	for(var attr in packers) this.packers[attr] = packers[attr];
}

Packr.prototype.generateMap = function(srcDir, outputFile) {
	var tree = {
		isDir: true,
		files: listFiles(srcDir)
	};

	//console.log(JSON.stringify(tree, null, '\t'));

	var packs = {};
	generateLoadMap(this.packers, packs, tree);

	//console.log(JSON.stringify(packs, null, '\t'));

	var yamlified = yaml.safeDump(packs);

	if(outputFile) {
		fs.writeFileSync(path.join(yamlDir, 'manifest.yaml'), yamlified);
	}

	return yamlified;
};

Packr.prototype.pack = function(srcDir, destDir, yamlManifest) {
	// clean dest dir
	execSync('rm -rf ' + destDir);
	mkdirp.sync(destDir);

	var packs = yaml.safeLoad(yamlManifest);

	// copy ids
	for(var id in packs) {
		packs[id].id = id;
	}

	var assets = {
		packs: {}
	};

	// let's pack everything !
	for(var id in packs) {
		packIt(packs, id, path.resolve(srcDir), path.resolve(destDir), assets, this.packers);
	}

	// compute filesizes
	assets.files = computeFileInfos(destDir);

	// clean useless files
	cleanUseless(packs, destDir, assets, this.packers);

	//console.log(packs);

	// write manifest
	fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(assets, null, '\t'));
};

module.exports = Packr;
