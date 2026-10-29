package in.equidron.cart;

import in.equidron.auth.SessionService;
import in.equidron.auth.UserRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

/** Resolves the cookie to a user id, and answers 401 the way the Node server does. */
@Component
public class SessionUser {

    @Autowired SessionService sessions;
    @Autowired UserRepository users;

    public long require(String token) {
        UserRepository.User user = sessions.resolve(token, users);
        if (user == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Please sign in.");
        return user.id();
    }
}