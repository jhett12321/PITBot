//Modules
var http = require('http');
var url = require('url');

var mkdirp = require('mkdirp');
var fs = require('fs');
var jf = require('jsonfile');
var parseString = require('xml2js').parseString;

var HipChatClient = require('hipchat-client');
var hipchat;

var JiraClient = require('jira-connector');
var jira;

//-------------------------------------------------------------------
/**
* 	PITBot: Launcher Update Detector
* 	Detects Upcoming and current updates for DGC Titles.
*   Also generates an archive of manifests for past reference.
*/
//-------------------------------------------------------------------

/**********************
    Initialisation    *
**********************/

//Config File.
var file = './data.json';
var config = {};

//Archive Base Dir
var baseArcDir = '/var/www/public/api.blackfeatherproductions.com/daybreak/manifests';
var baseURL = 'http://api.blackfeatherproductions.com/daybreak/manifests'

jf.readFile(file, function(err, obj)
{
	if(err)
		throw err;

	else if(obj != null)
	{
		console.log("Successfully Loaded Config Data!");
		config = obj;
        hipchat = new HipChatClient(config.hipchat_configuration.api_key);
        
        jira = new JiraClient( {
        host: config.jira_configuration.host,
        protocol: config.jira_configuration.protocol,
        basic_auth: {
            username: config.jira_configuration.username,
            password: config.jira_configuration.password
        }
        });
        
		init();
	}
});

function init()
{
	for (var key in config.game_list)
	{
		if(!config.game_list.hasOwnProperty(key))
		{
			continue;
		}
		
		QueryManifests(key, config.game_list[key]);
	}
}

/**************
    Client    *
**************/

//Main Query Loop.
function QueryManifests(gameKey, gameObject)
{
	//Do an initial query, before delaying
	for (var key in gameObject.manifest_list)
	{
		if(!gameObject.manifest_list.hasOwnProperty(key))
		{
			continue;
		}
		
		if(gameObject.manifest_list[key].enabled == "1")
		{
			GetManifestData(gameKey, key, gameObject.manifest_list[key]);
		}
	}

	var queryInterval = gameObject.query_interval;
	setInterval(function()
	{
		for (var key in gameObject.manifest_list)
		{
			if(!gameObject.manifest_list.hasOwnProperty(key))
			{
				continue;
			}
			
			GetManifestData(gameKey, key, gameObject.manifest_list[key]);
		}
	}, queryInterval);
}

/************************
    Query Functions     *
************************/

//Queries the provided maninfest link for info.
function GetManifestData(gameKey, manifestKey, manifest)
{
	var url = manifest.manifest_url;
	var lastUpdate = config.game_list[gameKey].manifest_list[manifestKey].last_updated;
	
	http.get(url, function(res)
	{
		var body = '';
		res.on('data', function(chunk)
		{
			body += chunk;
		});
		
		res.on('end', function()
		{
			parseString(body, function (err, manifestData)
			{
				if (err)
				{
					console.log(url);
					throw err;
				}
				
				if(lastUpdate != manifestData.digest.$.timestamp)
				{
					config.game_list[gameKey].manifest_list[manifestKey].last_updated = manifestData.digest.$.timestamp;
					
					jf.writeFile(file, config, function(err)
					{
						if(err) throw err;
					});
					
					//Broadcast to HipChat channels
					Broadcast(gameKey, manifestKey, manifestData);
					
					//Generate Archive Data
					GenerateArchive(body, gameKey, manifestKey, manifestData);
				}
			});
		});
		
	}).on('error', function(e)
	{
		throw e;
	});
}

function GenerateArchive(rawBody, gameKey, manifestKey, manifestData)
{
	var date = FileISODate(new Date(manifestData.digest.$.timestamp * 1000));
	
	var dir = baseArcDir + '/' + gameKey + '/' + manifestKey;
	var filePath = dir + '/' + date + '.xml';
	
    mkdirp(dir, '0755', function(err)
	{
        if (err)
		{
            if (err.code != 'EEXIST') // ignore the error if the folder already exists
			{
				console.log(err);
			}
		}
		
		fs.writeFile(filePath, rawBody, function(err)
		{
			if(err)
			{
				console.log(err);
			}
			
			console.log("Successfully wrote manifest file.");
		});
    });
}

function Broadcast(gameKey, manifestKey, manifestData)
{
	var gameName = config.game_list[gameKey].name;
	var color = config.game_list[gameKey].hipchat_color;
	var updateChannel = config.game_list[gameKey].manifest_list[manifestKey].name;
	var patchSize = manifestData.digest.$.packageSizeKB;
	var date = ISODateString(new Date(manifestData.digest.$.timestamp * 1000));
	var urlDate = FileISODate(new Date(manifestData.digest.$.timestamp * 1000));
	
	var manifestURL = baseURL + '/' + gameKey + '/' + manifestKey + '/' + urlDate + '.xml';
	
/* 	var message = "Detected new update for " + gameName + " on update channel " + updateChannel + ". Patch Size is " + patchSize + " KB.<br>" +
		"<strong>Game:</strong> " + gameName + " [" + gameKey + "]<br>" +
		"<strong>Channel:</strong> " + updateChannel + " [" + manifestKey + "]<br>" +
		"<strong>Time:</strong> " + date + "<br>" +
		"<a href='" + manifestURL + "'>Manifest Link</a>"; */
	
	var message = "Detected new update for " + gameName + " on update channel " + updateChannel + ". <br>" +
		"<strong>Game:</strong> " + gameName + " [" + gameKey + "]<br>" +
		"<strong>Channel:</strong> " + updateChannel + " [" + manifestKey + "]<br>" +
		"<strong>Time:</strong> " + date + "<br>" +
		"<a href='" + manifestURL + "'>Manifest Link</a>";
	
	console.log(message);
	
	if(manifestKey == "live" || manifestKey == "test")
	{
		JiraUpdate(gameKey, manifestKey, manifestData);
	}
	
	hipchat.api.rooms.message(
	{
		room_id: 1095869,
		from: 'PITBot',
		message: message,
		format: 'html',
		color: color,
		notify: 1
	}, function (err, res)
	{
		if (err) throw err;
	});
}

function JiraUpdate(gameKey, manifestKey, manifestData)
{
	var updateChannel = config.game_list[gameKey].manifest_list[manifestKey].name;

	var desc = VersionDesc(updateChannel, new Date(manifestData.digest.$.timestamp * 1000));
	var name = VersionName(updateChannel, new Date(manifestData.digest.$.timestamp * 1000));
	var releasedDate = VersionDate(new Date(manifestData.digest.$.timestamp * 1000));
	var userReleaseDate = VersionUserDate(new Date(manifestData.digest.$.timestamp * 1000));
	
	var project = config.game_list[gameKey].jira_project_key;
	var projectID = parseInt(config.game_list[gameKey].jira_project_id);
	
	if(project != null && project != undefined)
	{
		//Post New Version
		var obj =
		{
			"version":
			{
				"description": desc,
				"name": name,
				"released": true,
				"userReleaseDate": userReleaseDate,
				"projectId": projectID
			}
		}
		
		jira.version.createVersion(obj, function(err, body)
		{
			if(err) throw err;
			console.log("Created JIRA Version for " + project + " (" + name + ")");
			console.log(body);
			
			var modObj = 
			{
				"version":
				{
					"released": true
				},
				versionId: body.id
			}
			
			jira.version.editVersion(modObj, function(err, body)
			{
				if(err) throw err;
				console.log("Released JIRA Version for " + project + " (" + name + ")");
				console.log(body);
			});
		});
	}
}

function ISODateString(d)
{
    function pad(n) { return n<10 ? '0'+n : n }
    return      d.getUTCFullYear()
    + '-' + pad(d.getUTCMonth()+1)
    + '-' + pad(d.getUTCDate())
    + ' ' + pad(d.getUTCHours())
    + ':' + pad(d.getUTCMinutes())
    + ':' + pad(d.getUTCSeconds())
    + ' GMT'
}

function FileISODate(d)
{
    function pad(n) { return n<10 ? '0'+n : n }
    return      d.getUTCFullYear()
    + '-' + pad(d.getUTCMonth()+1)
    + '-' + pad(d.getUTCDate())
    + ' T' + pad(d.getUTCHours())
    + '-' + pad(d.getUTCMinutes())
    + '-' + pad(d.getUTCSeconds())
}

function pad(n)
{
	return n<10 ? '0'+n : n
}

function VersionName(uc, d)
{
    return		uc
	+ ' ' + d.getUTCFullYear()
    + '-' + pad(d.getUTCMonth()+1)
    + '-' + pad(d.getUTCDate())
}

function VersionDate(d)
{
    return      d.getUTCFullYear()
    + '-' + pad(d.getUTCMonth()+1)
    + '-' + pad(d.getUTCDate())
}

function VersionDesc(uc, d)
{
    return		uc
	+ ' ' + d.getMonthName('en')
    + ' ' + pad(d.getUTCDate())
    + ' ' + "Patch"
}

function VersionUserDate(d)
{
    return      d.getUTCDate()
    + '/' + d.getMonthNameShort('en')
    + '/' + d.getUTCFullYear()
}

Date.prototype.getMonthName = function(lang)
{
    lang = lang && (lang in Date.locale) ? lang : 'en';
    return Date.locale[lang].month_names[this.getMonth()];
};

Date.prototype.getMonthNameShort = function(lang)
{
    lang = lang && (lang in Date.locale) ? lang : 'en';
    return Date.locale[lang].month_names_short[this.getMonth()];
};

Date.locale = {
    en: {
       month_names: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
       month_names_short: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    }
};