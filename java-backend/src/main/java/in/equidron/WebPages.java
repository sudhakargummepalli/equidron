package in.equidron;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Set;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The app folders work with a trailing slash.
 *
 * Spring serves static files but has no directory welcome page, and Spring 6 normalises a trailing
 * slash away before matching, so a view controller for /shop/ never matches. A filter runs before that
 * normalisation and forwards the folder to its index.html, which is what a browser typed or a link
 * needs.
 */
@Configuration
public class WebPages {

    private static final Set<String> APPS = Set.of("/shop/", "/seller/", "/ops/");

    @Bean
    public FilterRegistrationBean<Filter> appFolderWelcome() {
        Filter filter = new Filter() {
            @Override
            public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
                    throws IOException, ServletException {
                if (req instanceof HttpServletRequest request && APPS.contains(request.getRequestURI())) {
                    request.getRequestDispatcher(request.getRequestURI() + "index.html").forward(req, res);
                    return;
                }
                chain.doFilter(req, res);
            }
        };
        FilterRegistrationBean<Filter> bean = new FilterRegistrationBean<>(filter);
        bean.addUrlPatterns("/shop/*", "/seller/*", "/ops/*");
        bean.setOrder(1);
        return bean;
    }
}