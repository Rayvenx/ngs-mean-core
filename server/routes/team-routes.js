const util = require('../utils');
const router = require('express').Router();
const User = require("../models/user-models");
const Team = require("../models/team-models");
const passport = require("passport");
const fs = require('fs');
const imageDataURI = require('image-data-uri');

/*
routes for team management --
GETS:
get - retrieves requested team

POSTS:
create - creates new team with calling user as captain
save - saves new team information
delete - deletes team
addMember - adds member
removeMember - removes member
uploadLogo - uploads logo 
*/


//get
// path: /team/get
// URI query param - team
// finds team of passed team name
// returns found team
router.get('/get', (req, res) => {
    const path = '/team/get';
    var team = req.query.team;
    team = decodeURIComponent(team);
    Team.findOne({
        teamName: team
    }).lean().then(
        (foundTeam) => {
            if (foundTeam) {
                res.status(200).send(util.returnMessaging(path, 'Found tedam', false, foundTeam));
            } else {
                res.status(200).send(util.returnMessaging(path, "Team not found", false, foundTeam));
            }
        }, (err) => {
            res.status(500).send(util.returnMessaging(path, "Error querying teams.", err));
        }
    );
});

// post
// path /team/delete
// accpets JSON body, must have teamName:""
// returns success or error http
router.post('/delete', passport.authenticate('jwt', {
    session: false
}), confirmCaptain, (req, res) => {
    const path = '/team/delete';
    var payloadTeamName = req.body.teamName;
    Team.findOneAndDelete({ teamName: payloadTeamName }).then((deletedTeam) => {
        if (deletedTeam) {
            removeAffectedUsers(deletedTeam.teamMembers);
            res.status(200).send(util.returnMessaging(path, 'Team has been deleted!', false, false));
        } else {
            res.status(500).send(util.returnMessaging(path, 'Team was not found for deletion'));
        }
    }, (err) => {
        res.status(500).send(util.returnMessaging(path, 'There was an error deleting the team', err));
    });
});

// post 
// path /team/create
// accepts json body of team
// returns success or error HTTP plus the json object of the created team
router.post('/create', passport.authenticate('jwt', {
    session: false
}), (req, res) => {
    const path = '/team/create';
    /* 
    TODO: THERE MAY BE FUTURE NEEDS FOR A CHECK FOR AN ADMIN ROLE TO ALLOW SOMEONE ELSE TO 
    CREATE A TEAM ON BEHALF OF SOMEONE ELSE, THIS WILL BE HANDLED LATER!!!!
    */
    var callingUser = req.user;
    if (callingUser.hasOwnProperty('teamInfo') && !util.isNullOrEmpty(callingUser.teamInfo) && callingUser.teamInfo.teamName) {
        res.status(500).send(util.returnMessaging(path, 'This user all ready belongs to a team!'));
    } else {
        var status;
        var message = {};
        var recievedTeam = req.body;

        recievedTeam.teamMembers = [];

        recievedTeam.captain = req.user.displayName;

        recievedTeam.teamMembers.push({
            "_id": req.user._id,
            "displayName": req.user.displayName
        });

        var name, lfm, lfmDet, avail, tz = false;
        if (util.isNullOrEmpty(recievedTeam.teamName)) {
            status = 400;
            message.nameError = "Null team name not allowed!";
        }
        if (util.isNullOrEmpty(recievedTeam.lookingForMore)) {
            status = 400;
            message.lookingForMoreError += "Must have a looking for more status!";
        }
        if (util.isNullOrEmpty(recievedTeam.lfmDetails)) {
            status = 400;
            message.lfmDetailsError += "Must have a looking for more details!";

        } else {
            if (util.isNullOrEmpty(recievedTeam.lfmDetails.availability)) {
                status = 400;
                message = {
                    "message": "Must have a looking for more details > availability!"
                };
            }
            if (util.isNullOrEmpty(recievedTeam.lfmDetails.timeZone)) {
                status = 400;
                message = {
                    "message": "Must have a looking for more details > timezone!"
                };
            }
        }

        if (!util.isNullOrEmpty(status) && !util.isNullOrEmpty(message)) {
            //we were missing data so send an error back.
            res.status(status).send(util.returnMessaging(path, message));
        } else {
            Team.findOne({
                teamName: recievedTeam.teamName
            }).then((found) => {
                if (found) {
                    res.status(500).send(util.returnMessaging(path, 'This team name all ready exists!'));
                } else {
                    new Team(
                        recievedTeam
                    ).save().then((newTeam) => {
                        res.status(200).send(util.returnMessaging(path, "Team created successfully", false, newTeam));
                        //this may need some refactoring if we add the ability for an admin to create a team!
                        User.findOne({
                            displayName: req.user.displayName
                        }).then((found) => {
                            if (found) {
                                found.teamInfo = {
                                    "teamId": newTeam._id,
                                    "teamName": newTeam.teamName
                                };
                                found.save().then((save) => {
                                    if (save) {
                                        //maybe some event logging, IDK.
                                    } else {
                                        //mor logging
                                    }
                                }, (err) => {
                                    //really need some persistent error loggging!
                                    console.log("err hannepend: ", err);
                                })
                            } else {

                            }
                        }, (err) => {
                            //maybe add some error logging
                            console.log("error happened: ", err);
                        });
                    }, (err) => {
                        res.status(500).send(util.returnMessaging(path, "Error creating new team", err));
                    });
                }
            }, (err) => {
                res.status(500).send(util.returnMessaging(path, "We encountered an error saving the team!", err));
            })
        }
    }
});


// post
// path: /team/addMember
// accepts json body, must have teamName , plus string 'addMember' 
// this member needs to be all ready existing in the system
// returns http success or error plus json object of updated team
router.post('/addMember', passport.authenticate('jwt', {
    session: false
}), confirmCaptain, (req, res) => {
    const path = '/team/addMember';
    //make sure the caller has access to add people to the team

    var callingUser = req.user;

    var payloadTeamName = req.body.teamName;
    var payloadMemberToAdd = req.body.addMember;
    Team.findOne({
        teamName: payloadTeamName
    }).then((foundTeam) => {
        if (foundTeam) {
            var cont = true;
            var foundTeamObject = foundTeam.toObject();
            if (foundTeamObject.hasOwnProperty('pendingMembers') && cont) {
                foundTeamObject.pendingMembers.forEach(function(member) {
                    if (member.displayName == payloadMemberToAdd) {
                        cont = false;
                        res.status(500).send(
                            util.returnMessaging(path, "User " + payloadMemberToAdd + " exists in pending members currently")
                        );
                    }
                });
            }
            if (foundTeamObject.hasOwnProperty('teamMembers') && cont) { //current members
                foundTeamObject.teamMembers.forEach(function(member) {
                    if (member.displayName == payloadMemberToAdd) {
                        cont = false;
                        res.status(500).send(
                            util.returnMessaging(path, "User " + payloadMemberToAdd + " exists in members currently")
                        );
                    }
                });
            }
            if (cont) {
                User.findOne({
                    displayName: payloadMemberToAdd
                }).then((foundUser) => {
                    if (foundUser) {
                        if (!foundTeamObject.hasOwnProperty('pendingMembers')) {
                            foundTeam.pendingMembers = [];
                        }
                        foundTeam.pendingMembers.push({
                            "systemId": foundUser._id,
                            "displayName": foundUser.displayName
                        });

                        foundTeam.save().then((saveOK) => {
                            res.status(200).send(
                                util.returnMessaging(path, "User added to pending members", false, saveOK)
                            );
                        }, (teamSaveErr) => {
                            res.status(500).send(
                                util.returnMessaging(path, "error adding user to team", err)
                            );
                        });
                    }
                }, (err) => {
                    res.status(500).send(
                        util.returnMessaging(path, "error finding user", err)
                    );
                })
            }

        } else {
            res.status(500).send(
                util.returnMessaging(path, "team was not found!")
            );
        }
    });

});


//post 
// path: /team/save
// accepts json body, must have JSON object of team and all properties being updated.
// returns http sucess or error, plus JSON object of updated team if success.
router.post('/save', passport.authenticate('jwt', {
    session: false
}), confirmCaptain, (req, res) => {
    const path = '/team/save';
    var payloadTeamName = req.body.teamName;
    var payload = req.body;
    Team.findOne({ teamName: payloadTeamName }).then((foundTeam) => {
        console.log('A');
        if (foundTeam) {
            console.log('B');
            // this might be something to be changed later -
            var captainRec = false;
            if (!util.isNullOrEmpty(payload.lookingForMore)) {
                console.log('setting the LFM');
                foundTeam.lookingForMore = payload.lookingForMore;
                console.log('foundTeam.lookingForMore ', foundTeam.lookingForMore);
                console.log('payload.lookingForMore ', payload.lookingForMore);
            }

            console.log('setting the LFMdetails');
            console.log('util.isNullOrEmpty(payload.lfmDetails) ', util.isNullOrEmpty(payload.lfmDetails));
            if (!util.isNullorUndefined(payload.lfmDetails)) {

                console.log('lfmDetails.availability');
                console.log('util.isNullOrUndifined(payload.lfmDetails.availability) ', util.isNullorUndefined(payload.lfmDetails.availability));
                if (!util.isNullorUndefined(payload.lfmDetails.availability)) {
                    if (!foundTeam.lfmDetails.availability) {
                        foundTeam.lfmDetails.availability = {};
                    }
                    foundTeam.lfmDetails.availability = payload.lfmDetails.availability;
                    console.log(foundTeam.lfmDetails.availability.toString());
                }

                console.log('lfmDetails.competitiveLevel');
                console.log('util.isNullOrEmpty(payload.lfmDetails.competitiveLevel) ', util.isNullOrEmpty(payload.lfmDetails.competitiveLevel));
                if (!util.isNullOrEmpty(payload.lfmDetails.competitiveLevel)) {
                    foundTeam.lfmDetails.competitiveLevel = payload.lfmDetails.competitiveLevel;
                }

                console.log('lfmDetails.descriptionOfTeam');
                console.log('util.isNullOrEmpty(payload.lfmDetails.descriptionOfTeam) ', util.isNullOrEmpty(payload.lfmDetails.descriptionOfTeam));
                if (!util.isNullOrEmpty(payload.lfmDetails.descriptionOfTeam)) {
                    foundTeam.lfmDetails.descriptionOfTeam = payload.lfmDetails.descriptionOfTeam;
                }

                console.log('util.isNullOrEmpty(payload.lfmDetails.rolesNeeded');
                console.log('util.isNullOrEmpty(payload.lfmDetails.rolesNeeded ', util.isNullOrEmpty(payload.lfmDetails.rolesNeeded))
                if (!util.isNullOrEmpty(payload.lfmDetails.rolesNeeded)) {
                    console.log('updating roles needed')
                    if (!foundTeam.lfmDetails.rolesNeeded) {
                        foundTeam.lfmDetails.rolesNeeded = {};
                    }
                    foundTeam.lfmDetails.rolesNeeded = payload.lfmDetails.rolesNeeded;
                }

                console.log('lfmDetails.timeZone');
                console.log('util.isNullOrEmpty(payload.lfmDetails.timeZone) ', util.isNullOrEmpty(payload.lfmDetails.timeZone))
                if (!util.isNullOrEmpty(payload.lfmDetails.timeZone)) {
                    console.log('updating timezone');
                    foundTeam.lfmDetails.timeZone = payload.lfmDetails.timeZone;
                }
            }
            if (!util.isNullOrEmpty(payload.captain)) {
                //do stuff with this
                //send message back, we won't allow this to change here.
                captainRec = true;
            }
            // console.log('this is the team updated ', foundTeam);
            foundTeam.save().then((savedTeam) => {
                var message = "";
                if (captainRec) {
                    message += "We do not allow captain to be changed here at this time please contact an admin! ";
                }
                message += "Team updated!";
                res.status(200).send(util.returnMessaging(path, message, false, savedTeam));
            }, (err) => {
                res.status(400).send(util.returnMessaging(path, 'Error saving team information', err));
            });
        } else {
            res.status(400).send(util.returnMessaging(path, "Team not found"));
        }
    }, (err) => {
        res.status(400).send(util.returnMessaging(path, 'Error finding team', err));
    })

});


//post
// path: /team/removeMemver
// requires teamName, and string or array of strings of members to remove
// returns http success or error; json object of updated team if save was successful.
router.post('/removeMember', passport.authenticate('jwt', {
    session: false
}), confirmCaptain, (req, res) => {
    const path = '/team/removeMember';
    var payloadTeamName = req.body.teamName;
    var payloadUser = req.body.remove;
    if (!Array.isArray(payloadUser) && typeof payloadUser !== 'string') {
        res.status(400).send(
            util.returnMessaging(path, "User to remove must be string or array", payloadUser)
        );
    }
    //grab the team from mongo for updating
    Team.findOne({
        teamName: payloadTeamName
    }).then((foundTeam) => {
        var indiciesToRemove = [];
        var usersRemoved = [];
        if (Array.isArray(payloadUser)) {
            for (var i = 0; i < foundTeam.teamMembers.length; i++) {
                if (payloadUser.indexOf(foundTeam.teamMembers[i].displayName) > -1) {
                    indiciesToRemove.push(i);
                }
            }
        } else {
            for (var i = 0; i < foundTeam.teamMembers.length; i++) {
                if (payloadUser == foundTeam.teamMembers[i].displayName) {
                    indiciesToRemove.push(i);
                }
            }
        }
        if (indiciesToRemove.length == 0) {
            res.status(400).send(
                util.returnMessaging(path, "User not found on team.", false, foundTeam)
            );
        } else {
            indiciesToRemove.forEach(function(index) {
                usersRemoved = usersRemoved.concat(foundTeam.teamMembers.splice(index, 1));
            });
            removeAffectedUsers(usersRemoved);
            foundTeam.save().then((savedTeam) => {
                if (savedTeam) {
                    res.status(200).send(
                        util.returnMessaging(path, "users removed from team", false, savedTeam)
                    );
                } else {
                    res.status(400).send(
                        util.returnMessaging(path, "users not removed from team", false, savedTeam));
                }
            }, (err) => {
                res.status(400).send(util.returnMessaging(path, "Unable to save team", err));
            });
        }
    }, (err) => {
        res.status(400).send(util.returnMessaging(path, "Error finding team.", err));
    });
});

router.post('/uploadLogo', passport.authenticate('jwt', {
    session: false
}), confirmCaptain, (req, res) => {
    const path = '/team/uploadLogo';
    let uploadDir = "../client/src/assets/teamImgs/";

    let teamName = req.body.teamName;
    let dataURI = req.body.logo;

    var decoded = Buffer.byteLength(dataURI, 'base64');

    console.log(decoded.length);
    if (decoded.length > 2500000) {
        res.status(500).send(util.returnMessaging(path, "File is too big!"));
    } else {

        var png = dataURI.indexOf('png');
        var jpg = dataURI.indexOf('jpg');
        var jpeg = dataURI.indexOf('jpeg');
        var gif = dataURI.indexOf('gif');

        var stamp = Date.now()
        stamp = stamp.toString();
        stamp = stamp.slice(stamp.length - 4, stamp.length);

        uploadDir += teamName + stamp + "_logo";
        if (png > -1) {
            uploadDir += '.png'
        }
        if (jpg > -1) {
            uploadDir += '.jpg'
        }
        if (jpeg > -1) {
            uploadDir += '.jpeg'
        }
        if (gif > -1) {
            uploadDir += '.gif'
        }
        imageDataURI.outputFile(dataURI, uploadDir).then((req) => {
            console.log('saved');
        }, (err) => {
            console.log('error saving');
        });

        Team.findOne({
            teamName: teamName
        }).then((foundTeam) => {
            if (foundTeam) {
                if (foundTeam) {
                    if (foundTeam.captain == req.user.displayName) {
                        var logoToDelete;
                        if (foundTeam.logo) {
                            logoToDelete = foundTeam.logo;
                        }
                        console.log('logoToDelete ', logoToDelete)
                        if (logoToDelete) {
                            deleteFile(logoToDelete);
                        }
                        foundTeam.logo = uploadDir;
                        foundTeam.save().then((savedTeam) => {
                            if (savedTeam) {
                                res.status(200).send(util.returnMessaging(path, "File uploaded!", false, savedTeam));
                            }
                        }, (err) => {

                            deleteFile(filePath);
                            res.status(500).send(util.returnMessaging(path, "Error uploading file", false));
                        })
                    } else {
                        deleteFile(filePath);
                        res.status(500).send(util.returnMessaging(path, "Error uploading file", false));
                    }
                } else {
                    deleteFile(filePath);
                    res.status(500).send(util.returnMessaging(path, "Error uploading file", false));
                }
            } else {
                deleteFile(filePath);
                res.status(500).send(util.returnMessaging(path, "Error uploading file", false));
            }
        }, (err) => {
            deleteFile(filePath);
            res.status(500).send(util.returnMessaging(path, "Error uploading file", err));
        });
    }

});


//helper function that removes users
function removeAffectedUsers(usersRemoved) {
    usersRemoved.forEach(function(user) {
        User.findOne({
            displayName: user.displayName
        }).then((foundUser) => {
            if (foundUser) {
                foundUser.teamInfo = {};
                foundUser.save().then((savedUser) => {
                    console.log('need some persistent logging');
                }, (err) => {
                    console.log('need some persistent logging');
                });
            } else {
                console.log('need some persistent logging');
            }
        }, (err) => {
            console.log('need some persistent logging');
        });
    });
}

function deleteFile(path) {
    fs.access(path, error => {
        if (!error) {
            fs.unlink(path, function(error) {
                console.log(error);
            });
        } else {
            console.log(error);
        }
    });
}

function renameFile(path, newPath) {
    fs.rename(path, newPath, function(err) {
        if (err) {
            console.log('rename err: ', err);
        }
    });
}

//this confirms that the calling user is a captain of the team
function confirmCaptain(req, res, next) {
    const path = 'captianCheck';
    var callingUser = req.user;
    var payloadTeamName = req.body.teamName;
    Team.findOne({
        teamName: payloadTeamName
    }).then((foundTeam) => {
        if (foundTeam) {
            if (foundTeam.captain == callingUser.displayName) {
                req.team = foundTeam;
                next();
            } else {
                res.status(401).send(
                    util.returnMessaging(path, "User not authorized to change team."));
            }
        } else {
            res.status(400).send(util.returnMessaging(path, "Team not found."));
        }
    }, (err) => {
        res.status(500).send(
            util.returnMessaging(path, "Error finding team", err)
        );
    });
}

module.exports = router;